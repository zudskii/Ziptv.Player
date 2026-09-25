const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Search-friendly form: case-insensitive, accent-insensitive ("Télé" matches "tele"),
 * whitespace-collapsed. Works for Georgian/Cyrillic as well (no transliteration).
 */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every whitespace-separated term of the query must appear in the text. */
export function matchesQuery(normalizedText: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return normalizedQuery.split(' ').every((term) => normalizedText.includes(term));
}
