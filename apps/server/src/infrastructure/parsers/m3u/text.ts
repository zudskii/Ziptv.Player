const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY_RE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi;
// C0/C1 control chars, zero-width chars and stray BOMs never belong in a label.
// eslint-disable-next-line no-control-regex -- intentional: this regex exists to strip control characters
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g;
const WHITESPACE_RE = /\s+/g;
/** Printable ASCII, no '&', no leading/trailing/double spaces. */
const CLEAN_ASCII_RE = /^(?:[!-%'-~]+(?: [!-%'-~]+)*)$/;

/** Decodes the handful of HTML entities that show up in real-world playlists (`AT&amp;T`). */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Canonical display form of a label: entities decoded, invisible characters removed,
 * whitespace collapsed, Unicode NFC. Letters/case are never changed.
 */
export function normalizeLabel(value: string | null | undefined): string {
  if (!value) return '';
  // Fast path (the vast majority of labels): clean printable ASCII needs no work at all.
  if (CLEAN_ASCII_RE.test(value)) return value;
  return decodeEntities(value)
    .replace(/[\t\n\r\f\v]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .normalize('NFC')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/** Identity used to decide whether two group labels are "the same group". */
export function groupIdentity(label: string): string {
  return label.toLowerCase();
}

const GENERIC_PATH_SEGMENTS = new Set([
  'index',
  'playlist',
  'master',
  'manifest',
  'chunklist',
  'mono',
  'live',
  'stream',
  'streams',
  'video',
  'hls',
  'play',
  'output',
  'tracks-v1a1',
]);

/** Best-effort human label for entries that have no title at all, so they are never dropped. */
export function deriveNameFromUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = safeDecodeURIComponent(segments[i] ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
    if (!segment || GENERIC_PATH_SEGMENTS.has(segment.toLowerCase())) continue;
    // Long opaque tokens (auth keys, hashes) make terrible names.
    if (segment.length > 24 && /^[a-z0-9_-]+$/i.test(segment)) continue;
    return `${segment} (${url.hostname})`;
  }
  return url.hostname || 'Untitled stream';
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strips CR/LF and caps length so a header value can never be used for header injection. */
export function sanitizeHeaderValue(value: string, maxLength = 2048): string | null {
  // eslint-disable-next-line no-control-regex -- intentional: this regex exists to strip control characters
  const cleaned = value.replace(/[\r\n\u0000]/g, '').trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}
