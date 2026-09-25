import { describe, expect, it } from 'vitest';

import { parseExtinf } from './attributes.js';
import { decodePlaylistBytes } from './decode.js';
import { parsePlaylistBytes, parsePlaylistText, PlaylistFormatError } from './parse-playlist.js';
import { detectStreamKind } from './stream-kind.js';

const m3u = (...lines: string[]) => lines.join('\n');

describe('parseExtinf', () => {
  it('splits the title at the first comma outside quotes', () => {
    const result = parseExtinf('-1 tvg-name="News, Weather" tvg-logo="http://x/a,b.png" group-title="News",CNN, International');
    expect(result.title).toBe('CNN, International');
    expect(result.attributes['tvg-name']).toBe('News, Weather');
    expect(result.attributes['tvg-logo']).toBe('http://x/a,b.png');
    expect(result.duration).toBe(-1);
  });

  it('keeps " - " inside titles (regression: old parser split it into artist/title)', () => {
    expect(parseExtinf('-1,Channel - HD').title).toBe('Channel - HD');
    expect(parseExtinf('-1 group-title="A",BBC - News - Live').title).toBe('BBC - News - Live');
  });

  it('handles unquoted, single-quoted and upper-case attributes', () => {
    const result = parseExtinf("0 TVG-ID=abc tvg-logo='http://x/y.png' group-title=Sports,Title");
    expect(result.attributes).toEqual({ 'tvg-id': 'abc', 'tvg-logo': 'http://x/y.png', 'group-title': 'Sports' });
    expect(result.title).toBe('Title');
    expect(result.duration).toBe(0);
  });

  it('accepts EXTINF without duration or without comma', () => {
    expect(parseExtinf('Just a title').title).toBe('Just a title');
    expect(parseExtinf('-1 tvg-id="x"').title).toBe('');
    expect(parseExtinf('-1.000000,Decimal').duration).toBe(-1);
  });
});

describe('parsePlaylistText — extended M3U', () => {
  it('attaches #EXTVLCOPT / #EXTGRP to the entry instead of creating bogus channels', () => {
    const result = parsePlaylistText(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="a",Channel A',
        '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (iPhone)',
        '#EXTVLCOPT:http-referrer=https://example.com/',
        '#EXTGRP:Movies',
        'http://host/a.m3u8',
        '#EXTINF:-1,Channel B',
        'http://host/b.m3u8',
      ),
    );
    expect(result.channels).toHaveLength(2);
    const [a, b] = result.channels;
    expect(a).toMatchObject({
      name: 'Channel A',
      groups: ['Movies'],
      url: 'http://host/a.m3u8',
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', referer: 'https://example.com/' },
    });
    expect(b).toMatchObject({ name: 'Channel B', groups: [], headers: {} });
  });

  it('parses Kodi pipe headers, #EXTHTTP and #KODIPROP headers with the right precedence', () => {
    const result = parsePlaylistText(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1 user-agent="attr-ua",A',
        'https://h/a.m3u8|User-Agent=pipe%2F1.0&Referer=https%3A%2F%2Fref.example%2F',
        '#EXTINF:-1,B',
        '#EXTHTTP:{"cookie":"sid=1","User-Agent":"json-ua"}',
        'https://h/b.m3u8',
        '#EXTINF:-1,C',
        '#KODIPROP:inputstream.adaptive.stream_headers=Origin=https://o.example&User-Agent=kodi',
        'https://h/c.m3u8',
      ),
    );
    expect(result.channels.map((c) => c.headers)).toEqual([
      { 'user-agent': 'pipe/1.0', referer: 'https://ref.example/' },
      { cookie: 'sid=1', 'user-agent': 'json-ua' },
      { origin: 'https://o.example', 'user-agent': 'kodi' },
    ]);
    expect(result.channels[0]?.url).toBe('https://h/a.m3u8');
  });

  it('never drops an entry with a URL: falls back to tvg-name, then to the URL', () => {
    const result = parsePlaylistText(
      m3u('#EXTM3U', '#EXTINF:-1 tvg-name="From TVG",', 'http://h/1.m3u8', '#EXTINF:-1,', 'http://cdn.example/sport-1/index.m3u8'),
    );
    expect(result.channels.map((c) => c.name)).toEqual(['From TVG', 'sport-1 (cdn.example)']);
  });

  it('unifies group spelling and splits ;-separated multi-groups', () => {
    const result = parsePlaylistText(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1 group-title="Sports",A',
        'http://h/a',
        '#EXTINF:-1 group-title=" SPORTS ",B',
        'http://h/b',
        '#EXTINF:-1 group-title="Family;Movies;sports",C',
        'http://h/c',
        '#EXTINF:-1 group-title="",D',
        'http://h/d',
      ),
    );
    expect(result.channels.map((c) => c.groups)).toEqual([['Sports'], ['Sports'], ['Family', 'Movies', 'Sports'], []]);
  });

  it('keeps non-Latin labels intact and decodes HTML entities', () => {
    const result = parsePlaylistText(
      m3u('#EXTM3U', '#EXTINF:-1 group-title="ქართული",რუსთავი 2', 'http://h/1', '#EXTINF:-1 group-title="Кино",AT&amp;T Кино', 'http://h/2'),
    );
    expect(result.channels.map((c) => [c.groups[0], c.name])).toEqual([
      ['ქართული', 'რუსთავი 2'],
      ['Кино', 'AT&T Кино'],
    ]);
  });

  it('reports orphan #EXTINF and invalid URIs as warnings with line numbers', () => {
    const result = parsePlaylistText(
      m3u('#EXTM3U', '#EXTINF:-1,No URL', '#EXTINF:-1,Good', 'http://h/good', '#EXTINF:-1,Bad', 'javascript:alert(1)', 'file.txt'),
    );
    expect(result.channels.map((c) => c.name)).toEqual(['Good']);
    expect(result.warnings.map((w) => [w.line, w.code])).toEqual([
      [2, 'orphan_extinf'],
      [5, 'invalid_url'],
      [7, 'invalid_url'],
    ]);
  });

  it('flags rtmp, DRM and web-page entries as unplayable instead of hiding them', () => {
    const result = parsePlaylistText(
      m3u(
        '#EXTM3U',
        '#EXTINF:-1,RTMP',
        'rtmp://h/live/stream',
        '#EXTINF:-1,DRM',
        '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
        'https://h/manifest.mpd',
        '#EXTINF:-1,YT',
        'https://www.youtube.com/c/somechannel/live',
        '#EXTINF:-1,Rutube HLS',
        'https://bl.rutube.ru/live/index.m3u8',
      ),
    );
    expect(result.channels.map((c) => [c.name, c.unplayableReason])).toEqual([
      ['RTMP', 'unsupported_protocol'],
      ['DRM', 'drm'],
      ['YT', 'web_page'],
      ['Rutube HLS', null],
    ]);
  });

  it('reads EPG urls from the header and resolves relative URIs against the source URL', () => {
    const result = parsePlaylistText(
      m3u('#EXTM3U url-tvg="http://epg/a.xml" x-tvg-url="http://epg/b.xml, http://epg/c.xml"', '#EXTINF:-1 tvg-logo="logos/a.png",A', 'streams/a.m3u8'),
      { baseUrl: new URL('https://provider.example/lists/main.m3u') },
    );
    expect(result.epgUrls).toEqual(['http://epg/a.xml', 'http://epg/b.xml', 'http://epg/c.xml']);
    expect(result.channels[0]).toMatchObject({
      url: 'https://provider.example/lists/streams/a.m3u8',
      logo: 'https://provider.example/lists/logos/a.png',
    });
  });

  it('produces stable, unique keys independent of the URL', () => {
    const first = parsePlaylistText(m3u('#EXTM3U', '#EXTINF:-1 group-title="G",A', 'http://h/a?token=1', '#EXTINF:-1 group-title="G",A', 'http://h/a2'));
    const second = parsePlaylistText(m3u('#EXTM3U', '#EXTINF:-1 group-title="g",A', 'http://h/a?token=2'));
    const [k1, k2] = first.channels.map((c) => c.key);
    expect(k1).toMatch(/^[0-9a-f]{12}$/);
    expect(k2).toBe(`${k1}-2`);
    expect(second.channels[0]?.key).toBe(k1);
  });

  it('truncates at maxChannels with a warning', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 5; i++) lines.push(`#EXTINF:-1,C${i}`, `http://h/${i}`);
    const result = parsePlaylistText(lines.join('\n'), { maxChannels: 3 });
    expect(result.channels).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.warnings.at(-1)?.code).toBe('truncated');
  });
});

describe('parsePlaylistText — other formats', () => {
  it('parses plain M3U (URLs only, CRLF, comments)', () => {
    const result = parsePlaylistText('# my list\r\nhttp://a.example/live/one.ts\r\n\r\nhttps://b.example/two.m3u8\r\n');
    expect(result.channels.map((c) => [c.name, c.kind])).toEqual([
      ['one (a.example)', 'mpegts'],
      ['two (b.example)', 'hls'],
    ]);
  });

  it('parses PLS in numeric order', () => {
    const result = parsePlaylistText('[playlist]\nFile2=http://h/2\nTitle2=Two\nFile1=http://h/1\nTitle1=One\nNumberOfEntries=2\n');
    expect(result.format).toBe('pls');
    expect(result.channels.map((c) => c.name)).toEqual(['One', 'Two']);
  });

  it('rejects HTML pages with an actionable error', () => {
    expect(() => parsePlaylistText('<!DOCTYPE html><html><body>Login</body></html>')).toThrow(PlaylistFormatError);
  });

  it('turns an HLS manifest URL into a single channel, but rejects it as an uploaded file', () => {
    const manifest = m3u('#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.ts');
    const fromUrl = parsePlaylistText(manifest, { baseUrl: new URL('https://cdn.example/news/index.m3u8') });
    expect(fromUrl.format).toBe('hls-manifest');
    expect(fromUrl.channels).toHaveLength(1);
    expect(fromUrl.channels[0]).toMatchObject({ url: 'https://cdn.example/news/index.m3u8', kind: 'hls' });
    expect(() => parsePlaylistText(manifest)).toThrow(/HLS stream manifest/);
  });
});

describe('decodePlaylistBytes', () => {
  const text = '#EXTM3U\n#EXTINF:-1 group-title="Кино",Первый канал\nhttp://h/1\n';

  it('strips the UTF-8 BOM (regression: BOM files returned HTTP 500)', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    const result = parsePlaylistBytes(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.channels[0]?.name).toBe('Первый канал');
  });

  it('decodes UTF-16LE with and without BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(decodePlaylistBytes(withBom).text).toBe(text);
    expect(decodePlaylistBytes(Buffer.from(text, 'utf16le'))).toEqual({ text, encoding: 'utf-16le' });
  });

  it('falls back to windows-1251 for legacy Cyrillic lists', () => {
    const cp1251 = new Uint8Array([
      ...Buffer.from('#EXTM3U\n#EXTINF:-1,'),
      0xcf, 0xe5, 0xf0, 0xe2, 0xfb, 0xe9, // "Первый"
      ...Buffer.from('\nhttp://h/1\n'),
    ]);
    const result = parsePlaylistBytes(cp1251);
    expect(result.encoding).toBe('windows-1251');
    expect(result.channels[0]?.name).toBe('Первый');
  });
});

describe('detectStreamKind', () => {
  it.each([
    ['http://h/live/index.m3u8?token=1', 'hls'],
    ['http://h/a/b/manifest.mpd', 'dash'],
    ['http://h:8080/live/user/pass/123.ts', 'mpegts'],
    ['http://h/stream.flv', 'flv'],
    ['http://h/movie.mp4', 'progressive'],
    ['http://h:8080/user/pass/123', 'unknown'],
    ['http://h/get.php?output=ts', 'mpegts'],
    ['http://h/play?type=m3u8', 'hls'],
  ])('%s → %s', (url, kind) => {
    expect(detectStreamKind(new URL(url))).toBe(kind);
  });
});
