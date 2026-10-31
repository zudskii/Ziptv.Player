/** Which entries of a playlist the list shows. */
export interface EntryFilter {
  /** `all`: the whole playlist in display order; `ungrouped`; or one group. */
  scope: { type: 'all' } | { type: 'ungrouped' } | { type: 'group'; groupId: string };
  search: string;
  /** Only entries whose channel vanished from its source. */
  missingOnly: boolean;
}

export const ALL_ENTRIES: EntryFilter = { scope: { type: 'all' }, search: '', missingOnly: false };

/** Hard server limit of one page (GET …/entries?limit=). */
export const MAX_PAGE_SIZE = 500;

/** Query string for GET …/entries; `search` is only sent when it says something. */
export function entriesQuery(filter: EntryFilter, page: { offset: number; limit: number }): string {
  const params = new URLSearchParams();
  if (filter.scope.type === 'ungrouped') params.set('ungrouped', 'true');
  if (filter.scope.type === 'group') params.set('groupId', filter.scope.groupId);
  const search = filter.search.trim();
  if (search) params.set('search', search);
  if (filter.missingOnly) params.set('status', 'missing');
  params.set('offset', String(page.offset));
  params.set('limit', String(Math.min(page.limit, MAX_PAGE_SIZE)));
  return params.toString();
}

/** Stable cache key for a filter (same filter → same cached pages). */
export function filterKey(filter: EntryFilter): string {
  const scope = filter.scope.type === 'group' ? `g:${filter.scope.groupId}` : filter.scope.type;
  return `${scope}|${filter.search.trim().toLowerCase()}|${filter.missingOnly ? 'missing' : ''}`;
}

/** Narrowing to a group never discards what the person typed in the search box. */
export function withScope(filter: EntryFilter, scope: EntryFilter['scope']): EntryFilter {
  return { ...filter, scope };
}
