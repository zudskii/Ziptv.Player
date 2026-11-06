import { describe, expect, it } from 'vitest';

import { canonicalGenres, GENRE_IDS, isGenreId } from './genres.js';

describe('canonicalGenres', () => {
  it('splits provider genre lists and maps them onto the canonical set, in canonical order', () => {
    expect(canonicalGenres(['Drama, Action / Adventure'])).toEqual(['action', 'adventure', 'drama']);
    expect(canonicalGenres(['Sci-Fi & Fantasy'])).toEqual(['fantasy', 'scifi']);
    expect(canonicalGenres(['Science Fiction'])).toEqual(['scifi']);
  });

  it('understands Georgian, Russian and other provider languages', () => {
    expect(canonicalGenres(['კომედია', 'საშინელებათა'])).toEqual(['comedy', 'horror']);
    expect(canonicalGenres(['Боевик, Комедия'])).toEqual(['action', 'comedy']);
    expect(canonicalGenres(['Мелодрама'])).toEqual(['romance']);
    expect(canonicalGenres(['Acción', 'Ciencia ficción'])).toEqual(['action', 'scifi']);
    expect(canonicalGenres(['Komödie', 'Animación'])).toEqual(['animation', 'comedy']);
    expect(canonicalGenres(['Научная фантастика'])).toEqual(['scifi']);
  });

  it('reads genres out of category names, ignoring prefixes and filler words', () => {
    expect(canonicalGenres([], ['EN | Action Movies HD'])).toEqual(['action']);
    expect(canonicalGenres([], ['VOD - Horror'])).toEqual(['horror']);
    expect(canonicalGenres([], ['Фильмы | Ужасы'])).toEqual(['horror']);
    expect(canonicalGenres(['Thriller'], ['Kids & Family'])).toEqual(['family', 'kids', 'thriller']);
  });

  it('matches whole words only and ignores what it does not know', () => {
    expect(canonicalGenres(['Dramatic Moments', 'Netflix', 'Top 250'])).toEqual([]);
    expect(canonicalGenres(['Warner Bros'])).toEqual([]);
    expect(canonicalGenres([''])).toEqual([]);
  });

  it('every id is recognised by isGenreId', () => {
    expect(GENRE_IDS.every(isGenreId)).toBe(true);
    expect(isGenreId('popcorn')).toBe(false);
  });
});
