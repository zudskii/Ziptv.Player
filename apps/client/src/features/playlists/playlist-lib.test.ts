import { describe, expect, it } from 'vitest';

import { ALL_ENTRIES, entriesQuery, filterKey, MAX_PAGE_SIZE, withScope } from './entry-filter';
import { locate, pagesForRange } from './paging';
import { chunk, idsInRange, idsToDrag, toggled } from './selection';

describe('entries query string', () => {
  it('asks for everything by default', () => {
    expect(entriesQuery(ALL_ENTRIES, { offset: 0, limit: 200 })).toBe('offset=0&limit=200');
  });

  it('narrows to a group, ungrouped, a search and missing entries', () => {
    expect(entriesQuery({ scope: { type: 'group', groupId: 'g1' }, search: ' euro ', missingOnly: true }, { offset: 400, limit: 200 })).toBe('groupId=g1&search=euro&status=missing&offset=400&limit=200');
    expect(entriesQuery({ scope: { type: 'ungrouped' }, search: '   ', missingOnly: false }, { offset: 0, limit: 50 })).toBe('ungrouped=true&offset=0&limit=50');
  });

  it('encodes what the person typed and never asks for more than the server allows', () => {
    expect(entriesQuery({ ...ALL_ENTRIES, search: '100% & more' }, { offset: 0, limit: 10_000 })).toBe(`search=100%25+%26+more&offset=0&limit=${MAX_PAGE_SIZE}`);
  });

  it('gives equal filters equal cache keys, ignoring case and spacing of the search', () => {
    expect(filterKey({ ...ALL_ENTRIES, search: ' Euro ' })).toBe(filterKey({ ...ALL_ENTRIES, search: 'euro' }));
    expect(filterKey(withScope(ALL_ENTRIES, { type: 'group', groupId: 'a' }))).not.toBe(filterKey(withScope(ALL_ENTRIES, { type: 'group', groupId: 'b' })));
    expect(filterKey(withScope({ ...ALL_ENTRIES, search: 'x' }, { type: 'ungrouped' }))).toContain('|x|');
  });
});

describe('paging', () => {
  it('always loads page 0 (it carries the total) plus the pages behind the visible rows and one around them', () => {
    expect(pagesForRange(0, 20, undefined)).toEqual([0, 1]);
    expect(pagesForRange(1000, 1030, 50_000)).toEqual([0, 4, 5, 6]);
    expect(pagesForRange(399, 401, 50_000)).toEqual([0, 1, 2, 3]);
  });

  it('does not ask for pages beyond the end', () => {
    expect(pagesForRange(0, 500, 150)).toEqual([0]);
    expect(pagesForRange(190, 199, 250)).toEqual([0, 1]);
    expect(pagesForRange(0, 10, 0)).toEqual([0]);
  });

  it('finds the page and slot of a row', () => {
    expect(locate(0)).toEqual({ page: 0, slot: 0 });
    expect(locate(199)).toEqual({ page: 0, slot: 199 });
    expect(locate(200)).toEqual({ page: 1, slot: 0 });
    expect(locate(1234)).toEqual({ page: 6, slot: 34 });
  });
});

describe('selection', () => {
  it('drags the whole selection when the dragged row is part of it, otherwise just the row', () => {
    const selected = new Set(['a', 'b']);
    expect(idsToDrag('a', selected).sort()).toEqual(['a', 'b']);
    expect(idsToDrag('z', selected)).toEqual(['z']);
    expect(idsToDrag('z', new Set())).toEqual(['z']);
  });

  it('toggles without mutating the original', () => {
    const original = new Set(['a']);
    expect([...toggled(original, 'b')].sort()).toEqual(['a', 'b']);
    expect([...toggled(original, 'a')]).toEqual([]);
    expect([...original]).toEqual(['a']);
  });

  it('selects a shift-click range in either direction, skipping rows that are not loaded', () => {
    const loaded: Record<number, string> = { 2: 'c', 3: 'd', 5: 'f' };
    expect(idsInRange(2, 5, (i) => loaded[i])).toEqual(['c', 'd', 'f']);
    expect(idsInRange(5, 2, (i) => loaded[i])).toEqual(['c', 'd', 'f']);
    expect(idsInRange(3, 3, (i) => loaded[i])).toEqual(['d']);
  });

  it('splits long id lists into server-sized requests', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 5)).toEqual([]);
  });
});
