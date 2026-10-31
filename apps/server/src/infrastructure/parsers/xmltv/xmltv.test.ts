import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { GuideFetchError, type XmltvChannel, type XmltvProgramme } from '../../../application/ports/xmltv.js';
import { readXmltvStream } from './xmltv-reader.js';

async function read(input: Buffer | string, maxBytes = 10_000_000) {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  let drains = 0;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  // Small chunks: elements are split across chunk boundaries, like a real download.
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 37) chunks.push(bytes.subarray(offset, offset + 37));
  const result = await readXmltvStream(Readable.from(chunks), {
    channel: (channel) => channels.push(channel),
    programme: (programme) => programmes.push(programme),
    drain: async () => {
      drains++;
    },
  }, { maxBytes, signal: new AbortController().signal });
  return { channels, programmes, drains, bytes: result.bytes };
}

const GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="bbc1.uk">
    <display-name lang="en">BBC One</display-name>
    <display-name>BBC 1</display-name>
    <icon src="http://img.example/bbc1.png"/>
  </channel>
  <programme start="20261001120000 +0000" stop="20261001130000 +0000" channel="bbc1.uk">
    <title lang="en">News &amp; Weather</title>
    <sub-title>Lunchtime</sub-title>
    <desc>Headlines.</desc>
    <category>News</category><category>News</category><category>Current affairs</category>
    <episode-num system="xmltv_ns">0.11.</episode-num>
    <rating system="MPAA"><value>PG</value></rating>
    <icon src="https://img.example/news.jpg"/>
  </programme>
  <programme start="20261001130000 +0000" stop="20261001140000 +0000" channel="orphan.id"><title>Synthetic</title></programme>
  <programme start="20261001140000 +0000" stop="20261001130000 +0000" channel="bbc1.uk"><title>Broken times</title></programme>
  <programme start="20261001140000 +0000" stop="20261001150000 +0000" channel="bbc1.uk"></programme>
</tv>`;

describe('XMLTV reader', () => {
  it('streams channels and programmes (entities, multiple names, icons, episode, rating)', async () => {
    const { channels, programmes, drains } = await read(GUIDE);
    expect(channels).toEqual([{ id: 'bbc1.uk', names: ['BBC One', 'BBC 1'], icon: 'http://img.example/bbc1.png' }]);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]).toEqual({
      channelId: 'bbc1.uk',
      start: new Date('2026-10-01T12:00:00Z'),
      stop: new Date('2026-10-01T13:00:00Z'),
      title: 'News & Weather',
      subtitle: 'Lunchtime',
      description: 'Headlines.',
      categories: ['News', 'Current affairs'],
      icon: 'https://img.example/news.jpg',
      episode: 'S1 E12',
      rating: 'PG',
    });
    expect(programmes[1]).toMatchObject({ channelId: 'orphan.id', title: 'Synthetic' });
    expect(drains).toBeGreaterThan(5);
  });

  it('reads gzip by magic bytes and legacy encodings from the prolog', async () => {
    expect((await read(gzipSync(GUIDE))).programmes).toHaveLength(2);
    const cyrillic = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1251"?><tv><channel id="1"><display-name>'),
      Buffer.from([0xcf, 0xe5, 0xf0, 0xe2, 0xfb, 0xe9]), // "Первый"
      Buffer.from('</display-name></channel></tv>'),
    ]);
    expect((await read(cyrillic)).channels[0]?.names).toEqual(['Первый']);
  });

  it('rejects web pages and oversized (decompressed) guides', async () => {
    await expect(read('<!doctype html><html><body>login</body></html>')).rejects.toBeInstanceOf(GuideFetchError);
    await expect(read('<rss></rss>')).rejects.toThrow(/Not an XMLTV guide/);
    const big = gzipSync(`<tv>${'<channel id="x"><display-name>pad</display-name></channel>'.repeat(5000)}</tv>`);
    await expect(read(big, 50_000)).rejects.toMatchObject({ problem: 'too_large' });
  });

  it('drops control characters (PostgreSQL rejects NUL in text)', async () => {
    const dirty = '<tv><channel id="a\u0000.tv"><display-name>A\u0001 TV</display-name></channel><programme start="20261001120000 +0000" stop="20261001130000 +0000" channel="a\u0000.tv"><title>News\u0000 at noon</title></programme></tv>';
    const { channels, programmes } = await read(dirty);
    expect(channels[0]).toMatchObject({ id: 'a.tv', names: ['A TV'] });
    expect(programmes[0]).toMatchObject({ channelId: 'a.tv', title: 'News at noon' });
  });
});
