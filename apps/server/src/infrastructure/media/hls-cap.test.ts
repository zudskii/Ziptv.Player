import { describe, expect, it } from 'vitest';

import { capHlsVariants } from './hls-rewriter.js';

const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
  'mid.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
  'high.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1920x1080,URI="iframe-high.m3u8"',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=640x360,URI="iframe-low.m3u8"',
].join('\n');

describe('capHlsVariants (licensed quality limit)', () => {
  it('leaves out variants taller than the limit, with their URI lines and I-frame playlists', () => {
    const capped = capHlsVariants(master, 720);
    expect(capped).toContain('low.m3u8');
    expect(capped).toContain('mid.m3u8');
    expect(capped).not.toContain('high.m3u8');
    expect(capped).not.toContain('iframe-high.m3u8');
    expect(capped).toContain('iframe-low.m3u8');
    expect(capped).not.toContain('1920x1080');
  });

  it('keeps every variant within the limit, and media playlists untouched', () => {
    expect(capHlsVariants(master, 2160)).toBe(master);
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';
    expect(capHlsVariants(media, 576)).toBe(media);
  });

  it('when every stated variant is too tall none is left; unstated resolutions survive only when nothing states one', () => {
    expect(capHlsVariants(master, 300)).not.toMatch(/\.m3u8$/m);
    const unstated = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nonly.m3u8';
    expect(capHlsVariants(unstated, 576)).toContain('only.m3u8');
    const mixed = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nunknown.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8';
    expect(capHlsVariants(mixed, 576)).not.toContain('unknown.m3u8');
  });
});
