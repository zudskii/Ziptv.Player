/**
 * A playlist can hold 50 000 entries, so the list loads fixed-size pages on demand: only the pages
 * behind the rows on screen (plus a little around them) are requested.
 */
export const PAGE_SIZE = 200;

/**
 * Pages needed to show rows `first`..`last`, one page of lookahead on each side.
 * Page 0 is always included: it tells how many entries there are in total.
 */
export function pagesForRange(first: number, last: number, total: number | undefined, pageSize = PAGE_SIZE, lookahead = 1): number[] {
  const pages = new Set<number>([0]);
  const lastRow = total === undefined ? last : Math.min(last, total - 1);
  if (lastRow >= first && first >= 0) {
    const from = Math.max(0, Math.floor(first / pageSize) - lookahead);
    let to = Math.floor(lastRow / pageSize) + lookahead;
    if (total !== undefined) to = Math.min(to, Math.max(0, Math.ceil(total / pageSize) - 1));
    for (let page = from; page <= to; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Which page and which slot inside it holds row `index`. */
export function locate(index: number, pageSize = PAGE_SIZE): { page: number; slot: number } {
  return { page: Math.floor(index / pageSize), slot: index % pageSize };
}
