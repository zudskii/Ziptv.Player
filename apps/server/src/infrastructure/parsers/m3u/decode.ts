export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Turns raw playlist bytes into text without mangling non-Latin labels.
 *
 * Order: BOM → BOM-less UTF-16 heuristic → strict UTF-8 → legacy single-byte code page.
 * Legacy Cyrillic lists (windows-1251) are still common among IPTV providers; decoding
 * them as UTF-8 is exactly what produces "�������" channel names.
 */
export function decodePlaylistBytes(bytes: Uint8Array): DecodedText {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return decode(bytes.subarray(3), 'utf-8');
  if (startsWith(bytes, [0xff, 0xfe])) return decode(bytes.subarray(2), 'utf-16le');
  if (startsWith(bytes, [0xfe, 0xff])) return decode(bytes.subarray(2), 'utf-16be');

  // Before strict UTF-8: BOM-less UTF-16 ASCII is *valid* UTF-8 (full of NULs).
  const utf16 = guessUtf16WithoutBom(bytes);
  if (utf16) return decode(bytes, utf16);

  const strictUtf8 = tryDecodeStrict(bytes, 'utf-8');
  if (strictUtf8 !== null) return { text: stripNul(strictUtf8), encoding: 'utf-8' };

  return decode(bytes, looksLikeCyrillicSingleByte(bytes) ? 'windows-1251' : 'windows-1252');
}

function decode(bytes: Uint8Array, encoding: string): DecodedText {
  try {
    return { text: stripNul(new TextDecoder(encoding).decode(bytes)), encoding };
  } catch {
    // Runtime without full ICU: latin1 never throws and keeps ASCII (URLs, tags) intact.
    return { text: stripNul(Buffer.from(bytes).toString('latin1')), encoding: 'latin1' };
  }
}

function tryDecodeStrict(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function stripNul(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: this regex exists to strip control characters
  return text.includes('\u0000') ? text.replace(/\u0000/g, '') : text;
}

/** ASCII text encoded as UTF-16 has a zero byte in every other position. */
function guessUtf16WithoutBom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = Math.min(bytes.length, 4096) & ~1;
  if (sample < 8) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const pairs = sample / 2;
  if (oddZeros / pairs > 0.4 && evenZeros / pairs < 0.05) return 'utf-16le';
  if (evenZeros / pairs > 0.4 && oddZeros / pairs < 0.05) return 'utf-16be';
  return null;
}

/**
 * Cyrillic text in windows-1251 is made of *runs* of bytes in 0xC0–0xFF (А–я),
 * while Western windows-1252 text only has isolated accented letters.
 */
function looksLikeCyrillicSingleByte(bytes: Uint8Array): boolean {
  let runs = 0;
  let isolated = 0;
  let current = 0;
  for (const byte of bytes) {
    if (byte >= 0xc0) {
      current++;
      continue;
    }
    if (current >= 3) runs++;
    else if (current > 0) isolated++;
    current = 0;
  }
  if (current >= 3) runs++;
  return runs > 0 && runs >= isolated;
}
