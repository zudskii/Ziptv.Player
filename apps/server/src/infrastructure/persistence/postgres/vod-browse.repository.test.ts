import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RevisionData, StoredMovie, StoredSeries } from '../../../application/ports/catalog-repository.js';
import type { NewSource } from '../../../application/ports/source-repository.js';
import type { VodBrowseQuery, VodBrowseScope } from '../../../application/ports/vod-browse-repository.js';
import { newEntityId } from '../../../domain/shared/ids.js';
import { searchTokens } from '../../../domain/shared/text.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { backfill } from './migrations/0014-vod-filters.js';
import { PgCatalogRepository } from './repositories/catalog.repository.js';
import { PgSourceRepository } from './repositories/source.repository.js';
import { PgUserRepository } from './repositories/user.repository.js';
import { PgVodBrowseRepository } from './repositories/vod-browse.repository.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const DAY = 86_400_000;

/**
 * Filters, facets and keyset paging across sources (Phase 15), on real PostgreSQL — plus the
 * performance gate: a 12 000-movie library answers filtered, faceted first pages with p95 < 200 ms.
 */
describe.skipIf(!TEST_DATABASE_URL)('VOD browse repository', () => {
  let testDb: TestDatabase;
  let browse: PgVodBrowseRepository;
  let catalog: PgCatalogRepository;
  let sources: PgSourceRepository;
  let ownerId: string;
  let profileId: string;
  let a: VodBrowseScope;
  let b: VodBrowseScope;

  const newSource = (): NewSource => ({
    id: sources.newId(),
    ownerId,
    name: 'Test source',
    type: 'm3u_url',
    origin: { kind: 'url', host: 'example.com' },
    credential: null,
    sync: { status: 'idle', stage: null, autoSync: true, intervalHours: 6, lastAttemptAt: null, lastSuccessAt: null, nextSyncAt: new Date(0), error: null, consecutiveFailures: 0, rerunRequested: false },
  });

  const movie = (index: number, overrides: Partial<StoredMovie> = {}): StoredMovie => {
    const name = overrides.name ?? `Movie ${index}`;
    return {
      key: `m${index.toString().padStart(6, '0')}`,
      position: index,
      name,
      year: 1950 + (index % 75),
      groups: [index % 4 === 0 ? 'EN | Action Movies' : index % 4 === 1 ? 'Комедии' : index % 4 === 2 ? 'Drama' : 'Docs'],
      poster: null,
      rating: index % 7 === 0 ? null : (index % 10) + 0.5,
      genres: index % 5 === 0 ? ['Thriller'] : [],
      durationSecs: index % 6 === 0 ? null : 60 * (60 + (index % 100)),
      plot: null,
      kind: 'progressive',
      locator: null,
      adult: index % 50 === 0,
      xtream: null,
      addedAt: index % 9 === 0 ? null : new Date(NOW.getTime() - (index % 400) * DAY),
      searchTokens: searchTokens(name),
      ...overrides,
    };
  };

  const series = (index: number): StoredSeries => ({
    key: `s${index}`,
    position: index,
    name: `Show ${index}`,
    year: 2000 + index,
    groups: ['Series | Comedy'],
    cover: null,
    rating: 7,
    genres: [],
    plot: null,
    adult: false,
    xtream: null,
    addedAt: null,
    searchTokens: searchTokens(`Show ${index}`),
    detailsFetchedAt: null,
  });

  const revision = (movies: StoredMovie[], shows: StoredSeries[] = []): RevisionData => ({ live: [], movies, series: shows, episodes: [] });

  const query = (overrides: Partial<VodBrowseQuery> = {}): VodBrowseQuery => ({
    scopes: [a, b],
    filters: {},
    hideAdult: false,
    profileId,
    sort: 'recent',
    after: null,
    limit: 40,
    facets: false,
    now: NOW,
    ...overrides,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const { db } = testDb.database;
    browse = new PgVodBrowseRepository(db);
    catalog = new PgCatalogRepository(db);
    sources = new PgSourceRepository(db);
    ownerId = (await new PgUserRepository(db).createGuest()).id;
    profileId = newEntityId();
    await sql`INSERT INTO profiles (id, user_id, name, kind, color) VALUES (${profileId}, ${ownerId}, 'Me', 'standard', '#3b82f6')`.execute(db);
    const sa = await sources.create(newSource());
    const sb = await sources.create(newSource());
    await catalog.insertRevision(sa.id, 1, revision(Array.from({ length: 300 }, (_, index) => movie(index)), [series(1), series(2)]));
    await catalog.insertRevision(sb.id, 1, revision(Array.from({ length: 200 }, (_, index) => movie(1000 + index))));
    a = { ref: { sourceId: sa.id, revision: 1 } };
    b = { ref: { sourceId: sb.id, revision: 1 } };
    // Progress: one finished movie, one started, in source A.
    for (const [key, completed] of [
      ['m000001', true],
      ['m000002', false],
    ] as const) {
      await sql`INSERT INTO progress (profile_id, source_id, content_type, key, title, position, duration, completed) VALUES (${profileId}, ${sa.id}, 'movie', ${key}, 'x', 100, 6000, ${completed})`.execute(db);
    }
    await sql`INSERT INTO progress (profile_id, source_id, content_type, series_key, key, title, position, duration) VALUES (${profileId}, ${sa.id}, 'episode', 's1', 'e1', 'x', 10, 1000)`.execute(db);
  });
  afterAll(async () => testDb?.close());

  it('stores canonical genres from provider genres and category names at import', async () => {
    const page = await browse.browseMovies(query({ filters: { genres: ['action'] }, limit: 500 }));
    expect(page.total).toBe(125); // every 4th movie: "EN | Action Movies"
    expect(page.items.every((item) => item.groups[0] === 'EN | Action Movies')).toBe(true);
    const comedy = await browse.browseMovies(query({ filters: { genres: ['comedy'] }, limit: 1 }));
    expect(comedy.total).toBe(125); // "Комедии"
    const both = await browse.browseMovies(query({ filters: { genres: ['comedy', 'thriller'] }, limit: 1 }));
    expect(both.total).toBe(125 + 100 - 25); // any-of: comedies plus thrillers not already comedies
  });

  it('each filter narrows the list and they combine', async () => {
    const all = await browse.browseMovies(query({ limit: 1 }));
    expect(all.total).toBe(500);
    expect((await browse.browseMovies(query({ hideAdult: true, limit: 1 }))).total).toBe(490);
    expect((await browse.browseMovies(query({ filters: { sourceIds: [b.ref.sourceId] }, limit: 1 }))).total).toBe(200);
    const nineties = await browse.browseMovies(query({ filters: { yearMin: 1990, yearMax: 1999 }, limit: 500 }));
    expect(nineties.items.every((item) => item.year! >= 1990 && item.year! <= 1999)).toBe(true);
    const good = await browse.browseMovies(query({ filters: { ratingMin: 8 }, limit: 500 }));
    expect(good.items.every((item) => item.rating !== null && item.rating >= 8)).toBe(true);
    const long = await browse.browseMovies(query({ filters: { length: 'long' }, limit: 500 }));
    expect(long.items.every((item) => item.durationSecs! > 7200)).toBe(true);
    const fresh = await browse.browseMovies(query({ filters: { addedSince: new Date(NOW.getTime() - 30 * DAY) }, limit: 500 }));
    expect(fresh.items.every((item) => item.addedAt !== null && item.addedAt.getTime() >= NOW.getTime() - 30 * DAY)).toBe(true);
    const named = await browse.browseMovies(query({ filters: { terms: ['movie', '12'] }, limit: 500 }));
    expect(named.items.map((item) => item.name).sort()).toEqual(['Movie 12', 'Movie 120', 'Movie 121', 'Movie 122', 'Movie 123', 'Movie 124', 'Movie 125', 'Movie 126', 'Movie 127', 'Movie 128', 'Movie 129'].sort());
    const combined = await browse.browseMovies(query({ filters: { genres: ['action'], ratingMin: 5, sourceIds: [a.ref.sourceId] }, limit: 500 }));
    expect(combined.items.every((item) => item.sourceId === a.ref.sourceId && item.groups[0] === 'EN | Action Movies' && item.rating! >= 5)).toBe(true);
    expect(combined.total).toBe(combined.items.length);
  });

  it("filters by the profile's progress: unwatched, started, finished", async () => {
    const scoped = { scopes: [a], limit: 500 } as const;
    expect((await browse.browseMovies(query({ ...scoped, filters: { watch: 'finished' } }))).items.map((item) => item.key)).toEqual(['m000001']);
    expect((await browse.browseMovies(query({ ...scoped, filters: { watch: 'started' } }))).items.map((item) => item.key)).toEqual(['m000002']);
    expect((await browse.browseMovies(query({ ...scoped, filters: { watch: 'unwatched' }, limit: 1 }))).total).toBe(298);
    expect((await browse.browseSeries(query({ ...scoped, filters: { watch: 'started' } }))).items.map((item) => item.key)).toEqual(['s1']);
    expect((await browse.browseSeries(query({ ...scoped, filters: { watch: 'unwatched' } }))).items.map((item) => item.key)).toEqual(['s2']);
    // Another profile has watched nothing.
    expect((await browse.browseMovies(query({ ...scoped, profileId: newEntityId(), filters: { watch: 'unwatched' }, limit: 1 }))).total).toBe(300);
  });

  it("leaves out a kids profile's hidden groups and items", async () => {
    const hidden = { ...a, hidden: { groups: ['Drama'], keys: ['m000000'] } };
    const page = await browse.browseMovies(query({ scopes: [hidden], limit: 500 }));
    expect(page.total).toBe(300 - 75 - 1);
    expect(page.items.some((item) => item.groups.includes('Drama') || item.key === 'm000000')).toBe(false);
  });

  it('keyset pages walk every item exactly once, in order, for every sort', async () => {
    for (const sort of ['recent', 'name', 'rating', 'year'] as const) {
      const seen: string[] = [];
      let after = null;
      let previous: (string | number)[] | null = null;
      for (let guard = 0; guard < 40; guard++) {
        const page: Awaited<ReturnType<PgVodBrowseRepository['browseMovies']>> = await browse.browseMovies(query({ sort, after, limit: 37 }));
        for (const item of page.items) {
          seen.push(`${item.sourceId}:${item.key}`);
          const key = sort === 'name' ? [item.name.toLowerCase()] : sort === 'rating' ? [-(item.rating ?? -1)] : sort === 'year' ? [-(item.year ?? -1)] : [-(item.addedAt?.getTime() ?? -1)];
          if (previous && sort !== 'name') expect(key[0]! >= previous[0]!).toBe(true);
          previous = key;
        }
        if (!page.next) break;
        after = page.next;
      }
      expect(seen).toHaveLength(500);
      expect(new Set(seen).size).toBe(500);
    }
  });

  it('counts each facet with the other filters applied (not its own)', async () => {
    const page = await browse.browseMovies(query({ filters: { genres: ['action'], sourceIds: [a.ref.sourceId] }, facets: true, limit: 1 }));
    const facets = page.facets!;
    // Sources: genre filter applied, source filter not.
    expect(facets.sources.find((s) => s.sourceId === a.ref.sourceId)?.count).toBe(75);
    expect(facets.sources.find((s) => s.sourceId === b.ref.sourceId)?.count).toBe(50);
    // Genres: source filter applied, genre filter not → other genres of source A are offered.
    expect(facets.genres.find((g) => g.id === 'action')?.count).toBe(75);
    expect(facets.genres.find((g) => g.id === 'comedy')?.count).toBe(75);
    expect(facets.genres.find((g) => g.id === 'thriller')?.count).toBe(60);
    // The rest: both filters applied.
    const sumDecades = facets.decades.reduce((sum, d) => sum + d.count, 0);
    expect(sumDecades).toBe(page.total);
    expect(facets.ratings.map((r) => r.min)).toEqual([5, 6, 7, 8]);
    expect(facets.ratings[0]!.count).toBeGreaterThanOrEqual(facets.ratings[3]!.count);
    expect(facets.lengths.map((l) => l.id)).toEqual(['short', 'medium', 'long']);
    expect(facets.added.map((x) => x.days)).toEqual([7, 30, 90, 365]);
  });

  it('the migration fills canonical genres of rows imported before it', async () => {
    const { db } = testDb.database;
    await sql`UPDATE movies SET genre_ids = '{}' WHERE source_id = ${a.ref.sourceId}`.execute(db);
    expect((await browse.browseMovies(query({ scopes: [a], filters: { genres: ['action'] }, limit: 1 }))).total).toBe(0);
    await backfill(db as never, 'movies');
    expect((await browse.browseMovies(query({ scopes: [a], filters: { genres: ['action'] }, limit: 1 }))).total).toBe(75);
  });

  it('nothing to browse: no scopes, or a source filter outside them', async () => {
    expect(await browse.browseMovies(query({ scopes: [] }))).toMatchObject({ items: [], total: 0, next: null });
    expect((await browse.browseMovies(query({ filters: { sourceIds: [newEntityId()] } }))).total).toBe(0);
  });

  it('gate: 12 000 movies, filtered + faceted first pages, p95 < 200 ms', { timeout: 120_000 }, async () => {
    const big = await sources.create(newSource());
    const movies = Array.from({ length: 12_000 }, (_, index) => movie(index, { key: `big${index}`, name: `Feature ${index} ${['Night', 'River', 'Storm', 'Echo'][index % 4]}`, searchTokens: searchTokens(`Feature ${index} ${['Night', 'River', 'Storm', 'Echo'][index % 4]}`) }));
    await catalog.insertRevision(big.id, 1, revision(movies));
    await sql`ANALYZE movies`.execute(testDb.database.db);
    const scope = { ref: { sourceId: big.id, revision: 1 } };
    const cases: Partial<VodBrowseQuery>[] = [
      { facets: true },
      { facets: true, filters: { genres: ['action'] } },
      { facets: true, filters: { genres: ['comedy', 'thriller'], ratingMin: 6 }, sort: 'rating' },
      { facets: true, filters: { yearMin: 1990, yearMax: 1999, length: 'medium' }, sort: 'year' },
      { facets: true, filters: { addedSince: new Date(NOW.getTime() - 90 * DAY) }, sort: 'name' },
      { facets: true, filters: { terms: ['storm'] }, hideAdult: true },
      { facets: true, filters: { watch: 'unwatched', genres: ['drama'] } },
    ];
    const timings: number[] = [];
    for (let round = 0; round < 6; round++) {
      for (const overrides of cases) {
        const started = performance.now();
        const page = await browse.browseMovies(query({ scopes: [scope], ...overrides }));
        timings.push(performance.now() - started);
        expect(page.items.length).toBeGreaterThan(0);
      }
    }
    timings.sort((x, y) => x - y);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    console.warn(`[vod-browse] 12k movies: p50 ${timings[Math.floor(timings.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${timings.length} faceted queries`);
    expect(p95).toBeLessThan(200);
  });
});
