import { describe, expect, it } from 'vitest';

import { MediaTokenCodec } from '../crypto/media-token.js';
import { assertUpstreamUrlAllowed, isPublicAddress } from '../http/network-policy.js';
import { isLiveMediaPlaylist, rewriteHlsPlaylist } from './hls-rewriter.js';
import { liveMediaExpiry } from './stream-proxy.js';
import { sniffStreamKind } from './stream-sniffer.js';

describe('MediaTokenCodec', () => {
  const secret = Buffer.from('x'.repeat(32));
  const grant = { kind: 'session' as const, id: 'sess-1' };
  let now = 1_000_000;
  const codec = new MediaTokenCodec(secret, 3600, () => now);

  it('round-trips url, headers, expiry and grant', () => {
    const token = codec.issue('http://h/a.m3u8', { 'user-agent': 'VLC' }, now + 60, grant);
    expect(codec.verify(token, 'stream')).toEqual({ url: 'http://h/a.m3u8', headers: { 'user-agent': 'VLC' }, expiresAt: now + 60, purpose: 'stream', grant });
  });

  it('is encrypted: nothing of the upstream URL or headers is readable', () => {
    const token = codec.issue('http://provider.example/user/secretpass/1.ts', { cookie: 'session=abc' }, now + 60, grant);
    const decoded = Buffer.from(token.slice(1), 'base64url').toString('latin1');
    for (const secretPart of ['provider.example', 'secretpass', 'session=abc', 'sess-1']) {
      expect(token).not.toContain(secretPart);
      expect(decoded).not.toContain(secretPart);
    }
    // Same input → same token (players match init sections/keys by URL across refreshes); any change → another token.
    expect(codec.issue('http://h/a', undefined, now + 60, grant)).toBe(codec.issue('http://h/a', undefined, now + 60, grant));
    expect(codec.issue('http://h/a', undefined, now + 61, grant)).not.toBe(codec.issue('http://h/a', undefined, now + 60, grant));
    expect(codec.issue('http://h/a', undefined, now + 60, { kind: 'session', id: 'sess-2' })).not.toBe(codec.issue('http://h/a', undefined, now + 60, grant));
  });

  it('rejects tampered, truncated, foreign-key, expired and legacy tokens', () => {
    const token = codec.issue('http://h/a.m3u8', undefined, now + 60, grant);
    const raw = Buffer.from(token.slice(1), 'base64url');
    raw[20] = raw[20]! ^ 1;
    expect(codec.verify(`2${raw.toString('base64url')}`, 'stream')).toBeNull();
    expect(codec.verify(token.slice(0, -4), 'stream')).toBeNull();
    expect(new MediaTokenCodec(Buffer.from('y'.repeat(32)), 3600, () => now).verify(token, 'stream')).toBeNull();
    // A 1.x/2.x signed token (base64url(json).signature) is not accepted.
    expect(codec.verify(`${Buffer.from(JSON.stringify({ u: 'http://169.254.169.254/', e: now + 60 })).toString('base64url')}.${'a'.repeat(32)}`, 'stream')).toBeNull();
    now += 61;
    expect(codec.verify(token, 'stream')).toBeNull();
  });
});

describe('rewriteHlsPlaylist', () => {
  const proxy = (url: string) => `P(${url})`;

  it('rewrites variants, segments and every URI attribute relative to the final URL', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1.key",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'low/index.m3u8?token=abc',
      '#EXTINF:6.0,',
      'https://cdn.other.example/seg1.ts',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-key"',
      '# plain comment',
      '',
    ].join('\r\n');

    const output = rewriteHlsPlaylist(input, new URL('http://origin.example/live/ch1/master.m3u8'), proxy);
    expect(output.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="P(http://origin.example/live/keys/k1.key)",IV=0x1',
      '#EXT-X-MAP:URI="P(http://origin.example/live/ch1/init.mp4)"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="P(http://origin.example/live/ch1/audio/en.m3u8)"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'P(http://origin.example/live/ch1/low/index.m3u8?token=abc)',
      '#EXTINF:6.0,',
      'P(https://cdn.other.example/seg1.ts)',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-key"',
      '# plain comment',
      '',
    ]);
  });

  it('tells playlists from media resources (token lifetimes differ)', () => {
    const roles: string[] = [];
    const record = (url: string, role: string) => {
      roles.push(`${role}:${url.split('/').pop()}`);
      return 'x';
    };
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="a.m3u8"\n#EXT-X-I-FRAME-STREAM-INF:URI="i.m3u8"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k.key"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
    rewriteHlsPlaylist(master, new URL('http://o/m.m3u8'), record);
    expect(roles).toEqual(['playlist:a.m3u8', 'playlist:i.m3u8', 'media:k.key', 'playlist:v.m3u8']);

    roles.length = 0;
    const media = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\ns1.ts\n#EXT-X-PART:DURATION=1,URI="p1.ts"\n#EXT-X-RENDITION-REPORT:URI="other.m3u8"\n';
    rewriteHlsPlaylist(media, new URL('http://o/v.m3u8'), record);
    expect(roles).toEqual(['init:init.mp4', 'media:s1.ts', 'media:p1.ts', 'playlist:other.m3u8']);
  });

  it('strict mode drops everything that could still name the upstream', () => {
    const input = [
      '#EXTM3U',
      '# made by http://panel.example/admin',
      '#EXT-X-DEFINE:NAME="base",VALUE="http://panel.example/u/p/"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.x",VALUE="https://panel.example/?token=t"',
      '#EXT-X-DATERANGE:ID="ad",START-DATE="2026-01-01T00:00:00Z",X-ASSET-LIST="http://ads.example/list"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6,',
      'seg1.ts',
    ].join('\n');
    const output = rewriteHlsPlaylist(input, new URL('http://panel.example/u/p/live.m3u8'), () => 'TOKEN', { strict: true });
    expect(output).not.toContain('panel.example');
    expect(output).not.toContain('ads.example');
    expect(output.split('\n')).toEqual(['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'TOKEN']);
    // Non-strict (a user's own source) keeps the playlist as is apart from the URIs.
    expect(rewriteHlsPlaylist(input, new URL('http://panel.example/u/p/live.m3u8'), () => 'TOKEN')).toContain('#EXT-X-DATERANGE');
  });

  it('buckets live media expiry so playlist refreshes keep identical segment URLs', () => {
    const grantExpiry = 1_000_000 + 6 * 3600;
    const a = liveMediaExpiry(1_000_000, grantExpiry);
    expect(liveMediaExpiry(1_000_010, grantExpiry)).toBe(a);
    expect(a - 1_000_000).toBeGreaterThanOrEqual(600);
    expect(a - 1_000_000).toBeLessThanOrEqual(900);
    expect(liveMediaExpiry(1_000_000, 1_000_100)).toBe(1_000_100); // never outlives the grant
  });

  it('detects live media playlists', () => {
    expect(isLiveMediaPlaylist('#EXTM3U\n#EXTINF:6,\ns.ts\n')).toBe(true);
    expect(isLiveMediaPlaylist('#EXTM3U\n#EXTINF:6,\ns.ts\n#EXT-X-ENDLIST\n')).toBe(false);
    expect(isLiveMediaPlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\ns.ts\n')).toBe(false);
    expect(isLiveMediaPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n')).toBe(false);
  });
});

describe('network policy (SSRF)', () => {
  it.each([
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['192.168.31.89', false],
    ['172.16.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fc00::1', false],
    ['::ffff:127.0.0.1', false],
    ['not-an-ip', false],
  ])('isPublicAddress(%s) = %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it('blocks literal private hosts and non-http schemes unless explicitly allowed', () => {
    expect(() => assertUpstreamUrlAllowed(new URL('http://127.0.0.1:27017/'), false)).toThrow(/non-public/);
    expect(() => assertUpstreamUrlAllowed(new URL('http://[::1]/'), false)).toThrow(/non-public/);
    expect(() => assertUpstreamUrlAllowed(new URL('http://localhost/'), false)).toThrow(/non-public/);
    expect(() => assertUpstreamUrlAllowed(new URL('file:///etc/passwd'), true)).toThrow();
    expect(() => assertUpstreamUrlAllowed(new URL('http://192.168.1.10/'), true)).not.toThrow();
    expect(() => assertUpstreamUrlAllowed(new URL('https://example.com/'), false)).not.toThrow();
  });
});

describe('sniffStreamKind', () => {
  const ts = Buffer.alloc(188 * 3);
  ts[0] = 0x47;
  ts[188] = 0x47;
  ts[376] = 0x47;

  it.each([
    ['hls', Buffer.from('\ufeff#EXTM3U\n#EXT-X-VERSION:3'), 'text/html'],
    ['mpegts', ts, 'application/octet-stream'],
    ['flv', Buffer.from('FLV\u0001\u0005'), undefined],
    ['progressive', Buffer.from('\u0000\u0000\u0000\u0018ftypmp42'), undefined],
    ['dash', Buffer.from('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash">'), 'text/xml'],
    ['hls', Buffer.from('garbage'), 'application/x-mpegURL'],
    ['unknown', Buffer.from('<html>login</html>'), 'text/html'],
  ])('detects %s', (expected, head, contentType) => {
    expect(sniffStreamKind(head, contentType)).toBe(expected);
  });
});
