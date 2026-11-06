import { describe, expect, it } from 'vitest';

import { activeFilterCount, NO_FILTERS, readFilters, writeFilters } from './filters';

describe('filter state in the URL', () => {
  it('round-trips and drops what it does not understand', () => {
    const filters = { ...NO_FILTERS, genres: ['action' as const, 'comedy' as const], decade: 1990, rating: 7, length: 'long' as const, added: 30, watch: 'unwatched' as const, q: 'heist' };
    const params = writeFilters(new URLSearchParams('sort=rating'), filters);
    expect(params.get('sort')).toBe('rating'); // other parameters are kept
    expect(readFilters(params, 'movies')).toEqual(filters);
    expect(activeFilterCount(filters)).toBe(8);

    const junk = new URLSearchParams('genres=action,popcorn&decade=1995&rating=9&length=forever&added=5&watch=finished&sources=nope');
    expect(readFilters(junk, 'series')).toEqual({ ...NO_FILTERS, genres: ['action'] }); // "finished" is for movies only
    expect(writeFilters(new URLSearchParams('genres=action&q=x'), NO_FILTERS).toString()).toBe('');
  });
});
