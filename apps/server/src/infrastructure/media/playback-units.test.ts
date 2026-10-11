import { describe, expect, it } from 'vitest';

import { MediaTokenCodec } from '../crypto/media-token.js';
import { assertUpstreamUrlAllowed, isPublicAddress } from '../http/network-policy.js';
import { rewriteHlsPlaylist } from './hls-rewriter.js';
import { sniffStreamKind } from './stream-sniffer.js';

describe('MediaTokenCodec', () => {
  const secret = Buffer.from('x'.repeat(32));
  let now = 1_000_000;
  const codec = new MediaTokenCodec(secret, 3600, () => now);

  it('round-trips url, headers and expiry', () => {
    const token = codec.issue('http://h/a.m3u8', { 'user-agent': 'VLC' }, now + 60);
    expect(codec.verify(token)).toEqual({ u: 'http://h/a.m3u8', h: { 'user-agent': 'VLC' }, e: now + 60 });
  });

  it('rejects tampered payloads, foreign keys and expired tokens', () => {
    const token = codec.issue('http://h/a.m3u8', undefined, now + 60);
    const [body, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ u: 'http://169.254.169.254/', e: now + 60 })).toString('base64url');
    expect(codec.verify(`${forged}.${signature}`)).toBeNull();
    expect(new MediaTokenCodec(Buffer.from('y'.repeat(32)), 3600, () => now).verify(token)).toBeNull();
    expect(codec.verify(`${body}.${signature.slice(1)}`)).toBeNull();
    now += 61;
    expect(codec.verify(token)).toBeNull();
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
