import { sql, type RawBuilder } from 'kysely';

import type { MovieSummary, SeriesSummary } from '../../../../application/ports/catalog-repository.js';
import {
  ADDED_WINDOWS_DAYS,
  RATING_STEPS,
  type VodBrowsePage,
  type VodBrowseQuery,
  type VodBrowseRepository,
  type VodCursor,
  type VodFacets,
  type VodLength,
} from '../../../../application/ports/vod-browse-repository.js';
import { isGenreId } from '../../../../domain/catalog/genres.js';
import type { Db } from '../database.js';
import { likeTerm } from '../search-sql.js';
import { MOVIE_SUMMARY_COLUMNS, SERIES_SUMMARY_COLUMNS, toMovieSummary, toSeriesSummary } from './catalog.repository.js';

type Kind = 'movies' | 'series';
type Facet = 'sources' | 'genres' | 'year' | 'rating' | 'length' | 'added';

const SHORT_SECS = 90 * 60;
const LONG_SECS = 120 * 60;
const DAY_MS = 86_400_000;

/**
 * Filtered, sorted, keyset-paged browsing across the sources of a profile's library, with facet
 * counts (Phase 15). Every query is bounded by `(source_id, revision)` of the pinned revisions —
 * a few thousand to tens of thousands of rows — so filters are plain predicates on that set; the
 * GIN index on `genre_ids` serves `&&` when the planner prefers it.
 *
 * Sorting: each order has a total key `(value, source_id, position)`; `value` is coalesced so
 * missing years/ratings/dates sort last and the keyset comparison never meets NULL.
 */
export class PgVodBrowseRepository implements VodBrowseRepository {
  constructor(private readonly db: Db) {}

  async browseMovies(query: VodBrowseQuery): Promise<VodBrowsePage<MovieSummary>> {
    const page = await this.browse('movies', query, MOVIE_SUMMARY_COLUMNS);
    return { ...page, items: page.rows.map((row) => ({ ...toMovieSummary(row as never), sourceId: row.source_id })) };
  }

  async browseSeries(query: VodBrowseQuery): Promise<VodBrowsePage<SeriesSummary>> {
    const page = await this.browse('series', query, SERIES_SUMMARY_COLUMNS);
    return { ...page, items: page.rows.map((row) => ({ ...toSeriesSummary(row as never), sourceId: row.source_id })) };
  }

  private async browse(kind: Kind, query: VodBrowseQuery, columns: readonly string[]) {
    if (query.scopes.length === 0) return { rows: [] as Row[], total: 0, next: null, ...(query.facets ? { facets: emptyFacets() } : {}) };
    const table = sql.table(kind);
    const order = sortKey(query.sort);
    const select = sql.join(columns.map((column) => sql.ref(`t.${column}`)));
    const keyset = query.after ? afterCursor(order, query.after) : sql`TRUE`;

    const [list, total, facets] = await Promise.all([
      sql<Row>`
        SELECT ${select}, t.source_id, ${order.expr} AS sort_value
          FROM ${table} AS t
         WHERE ${this.where(kind, query)} AND ${keyset}
         ORDER BY ${order.expr} ${order.desc ? sql`DESC` : sql`ASC`}, t.source_id, t.position
         LIMIT ${query.limit + 1}`.execute(this.db),
      sql<{ total: string }>`SELECT count(*) AS total FROM ${table} AS t WHERE ${this.where(kind, query)}`.execute(this.db),
      query.facets ? this.facets(kind, query) : Promise.resolve(undefined),
    ]);
    const rows = list.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const next: VodCursor | null = list.rows.length > query.limit && last ? { value: cursorValue(last.sort_value), sourceId: last.source_id, position: last.position } : null;
    return { rows, total: Number(total.rows[0]?.total ?? 0), next, ...(facets ? { facets } : {}) };
  }

  /** Each facet is counted with every filter except its own, so the other choices show what they would give. */
  private async facets(kind: Kind, query: VodBrowseQuery): Promise<VodFacets> {
    const table = sql.table(kind);
    const now = query.now.getTime();
    const [sources, genres, decades, ratings, lengths, added] = await Promise.all([
      sql<{ source_id: string; count: string }>`
        SELECT t.source_id, count(*) AS count FROM ${table} AS t WHERE ${this.where(kind, query, 'sources')} GROUP BY t.source_id`.execute(this.db),
      sql<{ id: string; count: string }>`
        SELECT g.id, count(*) AS count FROM ${table} AS t, unnest(t.genre_ids) AS g (id)
         WHERE ${this.where(kind, query, 'genres')} GROUP BY g.id`.execute(this.db),
      sql<{ decade: number; count: string }>`
        SELECT (t.year / 10) * 10 AS decade, count(*) AS count FROM ${table} AS t
         WHERE ${this.where(kind, query, 'year')} AND t.year BETWEEN 1880 AND 2100 GROUP BY 1 ORDER BY 1 DESC`.execute(this.db),
      sql<Record<string, string>>`
        SELECT ${sql.join(RATING_STEPS.map((step) => sql`count(*) FILTER (WHERE t.rating >= ${step}) AS ${sql.ref(`r${step}`)}`))}
          FROM ${table} AS t WHERE ${this.where(kind, query, 'rating')}`.execute(this.db),
      kind === 'movies'
        ? sql<Record<VodLength, string>>`
            SELECT count(*) FILTER (WHERE t.duration_secs > 0 AND t.duration_secs < ${SHORT_SECS}) AS short,
                   count(*) FILTER (WHERE t.duration_secs BETWEEN ${SHORT_SECS} AND ${LONG_SECS}) AS medium,
                   count(*) FILTER (WHERE t.duration_secs > ${LONG_SECS}) AS long
              FROM ${table} AS t WHERE ${this.where(kind, query, 'length')}`.execute(this.db)
        : Promise.resolve(null),
      sql<Record<string, string>>`
        SELECT ${sql.join(ADDED_WINDOWS_DAYS.map((days) => sql`count(*) FILTER (WHERE t.added_at >= ${new Date(now - days * DAY_MS)}) AS ${sql.ref(`d${days}`)}`))}
          FROM ${table} AS t WHERE ${this.where(kind, query, 'added')}`.execute(this.db),
    ]);
    const lengthRow = lengths?.rows[0];
    return {
      sources: sources.rows.map((row) => ({ sourceId: row.source_id, count: Number(row.count) })),
      genres: genres.rows
        .filter((row) => isGenreId(row.id))
        .map((row) => ({ id: row.id as VodFacets['genres'][number]['id'], count: Number(row.count) }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
      decades: decades.rows.map((row) => ({ decade: Number(row.decade), count: Number(row.count) })),
      ratings: RATING_STEPS.map((min) => ({ min, count: Number(ratings.rows[0]?.[`r${min}`] ?? 0) })),
      lengths: lengthRow ? (['short', 'medium', 'long'] as const).map((id) => ({ id, count: Number(lengthRow[id]) })) : [],
      added: ADDED_WINDOWS_DAYS.map((days) => ({ days, count: Number(added.rows[0]?.[`d${days}`] ?? 0) })),
    };
  }

  /** All filters (but `except`), adult, kids' hidden content and the pinned revisions. */
  private where(kind: Kind, query: VodBrowseQuery, except?: Facet): RawBuilder<boolean> {
    const { filters } = query;
    const scopes = except !== 'sources' && filters.sourceIds ? query.scopes.filter((scope) => filters.sourceIds!.includes(scope.ref.sourceId)) : query.scopes;
    if (scopes.length === 0) return sql<boolean>`FALSE`;
    const parts: RawBuilder<unknown>[] = [
      sql`(${sql.join(
        scopes.map((scope) => {
          const hiddenGroups = scope.hidden?.groups.length ? sql` AND NOT (t.groups && ${sql.val(scope.hidden.groups)}::text[])` : sql``;
          const hiddenKeys = scope.hidden?.keys.length ? sql` AND NOT (t.key = ANY(${sql.val(scope.hidden.keys)}::text[]))` : sql``;
          return sql`(t.source_id = ${scope.ref.sourceId} AND t.revision = ${scope.ref.revision}${hiddenGroups}${hiddenKeys})`;
        }),
        sql` OR `,
      )})`,
    ];
    if (query.hideAdult) parts.push(sql`t.adult = false`);
    if (filters.category) parts.push(sql`t.groups @> ARRAY[${filters.category}]::text[]`);
    for (const term of filters.terms ?? []) parts.push(sql`t.search LIKE ${likeTerm(term)}`);
    if (except !== 'genres' && filters.genres?.length) parts.push(sql`t.genre_ids && ${sql.val([...filters.genres])}::text[]`);
    if (except !== 'year') {
      if (filters.yearMin !== undefined) parts.push(sql`t.year >= ${filters.yearMin}`);
      if (filters.yearMax !== undefined) parts.push(sql`t.year <= ${filters.yearMax}`);
    }
    if (except !== 'rating' && filters.ratingMin !== undefined) parts.push(sql`t.rating >= ${filters.ratingMin}`);
    if (except !== 'length' && filters.length && kind === 'movies') {
      parts.push(
        filters.length === 'short'
          ? sql`t.duration_secs > 0 AND t.duration_secs < ${SHORT_SECS}`
          : filters.length === 'medium'
            ? sql`t.duration_secs BETWEEN ${SHORT_SECS} AND ${LONG_SECS}`
            : sql`t.duration_secs > ${LONG_SECS}`,
      );
    }
    if (except !== 'added' && filters.addedSince) parts.push(sql`t.added_at >= ${filters.addedSince}`);
    if (filters.watch) parts.push(watchPredicate(kind, query.profileId, filters.watch));
    return sql<boolean>`${sql.join(parts, sql` AND `)}`;
  }
}

interface Row {
  source_id: string;
  position: number;
  sort_value: string | number;
  [column: string]: unknown;
}

function watchPredicate(kind: Kind, profileId: string, watch: NonNullable<VodBrowseQuery['filters']['watch']>): RawBuilder<unknown> {
  if (kind === 'series') {
    const started = sql`EXISTS (SELECT 1 FROM progress p WHERE p.profile_id = ${profileId} AND p.source_id = t.source_id AND p.content_type = 'episode' AND p.series_key = t.key)`;
    return watch === 'unwatched' ? sql`NOT ${started}` : started;
  }
  const row = sql`SELECT 1 FROM progress p WHERE p.profile_id = ${profileId} AND p.source_id = t.source_id AND p.content_type = 'movie' AND p.series_key = '' AND p.key = t.key`;
  if (watch === 'unwatched') return sql`NOT EXISTS (${row})`;
  return sql`EXISTS (${row} AND p.completed = ${watch === 'finished'})`;
}

interface SortKey {
  expr: RawBuilder<unknown>;
  desc: boolean;
  numeric: boolean;
}

function sortKey(sort: VodBrowseQuery['sort']): SortKey {
  switch (sort) {
    case 'name':
      return { expr: sql`lower(t.name)`, desc: false, numeric: false };
    case 'rating':
      return { expr: sql`coalesce(t.rating, -1)`, desc: true, numeric: true };
    case 'year':
      return { expr: sql`coalesce(t.year, -1)`, desc: true, numeric: true };
    default:
      // Milliseconds as an exact numeric (the cursor carries it back unchanged).
      return { expr: sql`coalesce(floor(extract(epoch FROM t.added_at) * 1000), -1)`, desc: true, numeric: true };
  }
}

function afterCursor(order: SortKey, cursor: VodCursor): RawBuilder<boolean> {
  const value = order.numeric ? sql`${String(cursor.value)}::numeric` : sql`${String(cursor.value)}::text`;
  const beyond = order.desc ? sql`${order.expr} < ${value}` : sql`${order.expr} > ${value}`;
  return sql<boolean>`(${beyond} OR (${order.expr} = ${value} AND (t.source_id, t.position) > (${cursor.sourceId}::uuid, ${cursor.position})))`;
}

function cursorValue(value: string | number): string | number {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

function emptyFacets(): VodFacets {
  return { sources: [], genres: [], decades: [], ratings: RATING_STEPS.map((min) => ({ min, count: 0 })), lengths: [], added: ADDED_WINDOWS_DAYS.map((days) => ({ days, count: 0 })) };
}
