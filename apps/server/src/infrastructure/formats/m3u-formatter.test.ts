import { describe, expect, it } from 'vitest';

import { parsePlaylistText } from '../parsers/m3u/parse-playlist.js';
import { M3uFormatter } from './m3u-formatter.js';

const formatter = new M3uFormatter();
const base = { name: 'Euronews', number: null, logo: null, tvgId: null, groupName: null, url: 'http://example.com/e.m3u8', headers: {}, catchup: null };

describe('M3uFormatter', () => {
  it('writes a minimal channel', () => {
    expect(formatter.header() + formatter.channel(base)).toBe('#EXTM3U\n#EXTINF:-1,Euronews\nhttp://example.com/e.m3u8\n');
  });

  it('writes every attribute that has a value, in a fixed order', () => {
    const text = formatter.channel({
      ...base, number: 12, logo: 'http://x/l.png', tvgId: 'euronews.fr', groupName: 'News',
      catchup: { mode: 'shift', days: 3, template: '?utc={utc}' },
    });
    expect(text.split('\n')[0]).toBe('#EXTINF:-1 tvg-id="euronews.fr" tvg-chno="12" tvg-logo="http://x/l.png" group-title="News" catchup="shift" catchup-days="3" catchup-source="?utc={utc}",Euronews');
  });

  it('keeps stream headers as EXTVLCOPT lines before the URL', () => {
    const text = formatter.channel({ ...base, headers: { 'user-agent': 'VLC/3', referer: 'http://ref/', cookie: 'a=b' } });
    expect(text).toBe('#EXTINF:-1,Euronews\n#EXTVLCOPT:http-user-agent=VLC/3\n#EXTVLCOPT:http-referrer=http://ref/\n#EXTVLCOPT:http-cookie=a=b\nhttp://example.com/e.m3u8\n');
  });

  it('leaves Xtream catch-up out (it needs the account, not a URL template)', () => {
    expect(formatter.channel({ ...base, catchup: { mode: 'xtream', days: 7, template: null } })).not.toContain('catchup');
  });

  it('cannot be broken by hostile names, groups or URLs', () => {
    const text = formatter.channel({ ...base, name: 'Evil\n#EXTINF:-1,Injected', groupName: 'A"B\r\nC', tvgId: 'x" tvg-chno="1', url: 'http://a/b\n#EXTM3U' });
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2); // one EXTINF line and one URL line — nothing smuggled in
    expect(lines[0]).not.toMatch(/group-title="A"B/);
    expect(lines[1]).toBe('http://a/b #EXTM3U');
  });

  it('round-trips through our own parser: name, group, number, logo, tvg-id, headers, catch-up', () => {
    const channels = [
      { ...base, number: 7, logo: 'http://x/l.png', tvgId: 'one', groupName: 'News, Weather', headers: { 'user-agent': 'UA/1', referer: 'http://r/' }, catchup: { mode: 'append' as const, days: 2, template: null } },
      { ...base, name: 'Second', url: 'http://example.com/2.ts' },
    ];
    const text = formatter.header() + channels.map((c) => formatter.channel(c)).join('');
    const { channels: parsed } = parsePlaylistText(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      name: 'Euronews', groups: ['News, Weather'], logo: 'http://x/l.png', tvgId: 'one',
      url: 'http://example.com/e.m3u8', headers: { 'user-agent': 'UA/1', referer: 'http://r/' },
    });
    expect(parsed[0]!.attributes).toMatchObject({ 'tvg-chno': '7', catchup: 'append', 'catchup-days': '2' });
    expect(parsed[1]).toMatchObject({ name: 'Second', groups: [], url: 'http://example.com/2.ts' });
  });
});
