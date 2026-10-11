/**
 * Text rules shared by search, EPG matching and "same channel in another source".
 * Pure functions: no I/O, no framework.
 */

const COMBINING_MARKS = /\p{M}+/gu;
const NON_WORD = /[^\p{L}\p{N}+]+/gu;
const MAX_TOKENS = 32;
const MAX_TOKEN_LENGTH = 40;

/** Case/accent-insensitive form ("Télé  Monte-Carlo" → "tele monte-carlo"). Works for any script. */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Index tokens for prefix search: every word of the text, de-duplicated, in order.
 * "Sky Sports F1 HD" → ["sky", "sports", "f1", "hd"]. Queries match when every query term
 * is a prefix of some token, so "spo f1" finds it while the index stays a plain multikey array.
 */
export function searchTokens(...values: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of normalizeForSearch(value).split(NON_WORD)) {
      if (!token || token === '+') continue;
      tokens.add(token.slice(0, MAX_TOKEN_LENGTH));
      if (tokens.size >= MAX_TOKENS) return [...tokens];
    }
  }
  return [...tokens];
}

/** Query terms for `searchTokens`-indexed fields (same normalisation, at most 6 terms). */
export function queryTerms(query: string): string[] {
  return [...new Set(normalizeForSearch(query).split(NON_WORD).filter((term) => term && term !== '+'))].slice(0, 6);
}

/** Quality/format markers that differ between "the same" channel in two playlists or guides. */
const QUALITY_TOKENS = new Set([
  'hd',
  'fhd',
  'uhd',
  'sd',
  'hq',
  'lq',
  '4k',
  '8k',
  'hevc',
  'h264',
  'h265',
  'x264',
  'x265',
  '1080',
  '1080p',
  '1080i',
  '720',
  '720p',
  '576',
  '576p',
  '480p',
  '2160p',
  '50fps',
  '60fps',
  'fps',
  'backup',
  'raw',
  'vip',
  'tv',
]);

/**
 * Canonical channel identity for fuzzy matching:
 * "UK: BBC One HD", "BBC ONE FHD", "|UK| BBC One (1080p)" → "bbc one".
 * "+1" (time-shift) is kept on purpose: "BBC One +1" is a different schedule.
 */
export function normalizeChannelName(name: string): string {
  let value = normalizeForSearch(name);
  // Country/language prefixes: "UK:", "US |", "|EN|", "[DE]", "FR -".
  value = value.replace(/^(?:\|[\p{L}]{2,3}\||\[[\p{L}]{2,3}\]|[\p{L}]{2,3}\s*[:|]|[\p{L}]{2}\s+-)\s*/u, '');
  // Bracketed decorations: "(1080p)", "[Multi-Audio]", "{backup}".
  value = value.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  const tokens = value
    .split(NON_WORD)
    .filter((token) => token && !QUALITY_TOKENS.has(token));
  return tokens.join(' ').trim();
}

/** Escapes a string for use inside a RegExp (prefix queries). */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
