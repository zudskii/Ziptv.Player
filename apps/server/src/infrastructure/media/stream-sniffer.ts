import type { StreamKind } from '../../domain/catalog/model.js';
import { looksLikeHlsPlaylist } from './hls-rewriter.js';

const TS_PACKET = 188;
const TS_SYNC = 0x47;

/**
 * Identifies a stream container from its first bytes (and Content-Type as a hint).
 * Byte signatures win over headers because IPTV servers routinely lie about Content-Type
 * (`text/html` for m3u8, `application/octet-stream` for everything).
 */
export function sniffStreamKind(head: Buffer, contentType?: string): StreamKind {
  if (looksLikeHlsPlaylist(head)) return 'hls';
  if (isMpegTs(head)) return 'mpegts';
  if (head.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'progressive';
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'progressive'; // Matroska/WebM
  if (head.subarray(0, 3).toString('latin1') === 'ID3' || isAdtsOrMp3(head)) return 'progressive';

  const text = head.subarray(0, 512).toString('utf8').toLowerCase();
  if (text.includes('<mpd')) return 'dash';

  const type = contentType?.toLowerCase() ?? '';
  if (type.includes('mpegurl')) return 'hls';
  if (type.includes('dash+xml')) return 'dash';
  if (type.includes('mp2t')) return 'mpegts';
  if (type.includes('x-flv')) return 'flv';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'progressive';
  return 'unknown';
}

function isMpegTs(head: Buffer): boolean {
  if (head.length < 1 || head[0] !== TS_SYNC) return false;
  // One packet is weak evidence; check following sync bytes when we have them.
  for (let offset = TS_PACKET; offset < Math.min(head.length, TS_PACKET * 4); offset += TS_PACKET) {
    if (head[offset] !== TS_SYNC) return false;
  }
  return true;
}

function isAdtsOrMp3(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0;
}
