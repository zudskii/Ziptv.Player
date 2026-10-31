import { searchTokens } from '../../../domain/shared/text.js';

/** ' token token ' — word-prefix search with LIKE '% term%' (pg_trgm GIN indexes). */
export function searchText(...values: (string | null | undefined)[]): string {
  return tokensText(searchTokens(...values));
}

export function tokensText(tokens: readonly string[]): string {
  return tokens.length ? ` ${tokens.join(' ')} ` : '';
}

/** LIKE pattern for one query term: matches a word that starts with it. */
export function likeTerm(term: string): string {
  return `% ${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
