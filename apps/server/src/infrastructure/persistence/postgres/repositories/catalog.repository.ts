import { sql, type Insertable, type Selectable, type SelectQueryBuilder } from 'kysely';

import type {
  AddedAtIndex,
  CatalogRepository,
  CatalogSearchResult,
  MovieSummary,
  RecentlyAddedRow,
  SeriesSummary,
  VodListQuery,
  VodSortOrder,
  LiveChannelSummary,
  LiveLinkTarget,
  RevisionData,
  SourceRevisionRef,
  StoredEpisode,
  StoredLiveChannel,
  StoredMovie,
  StoredSeries,
} from '../../../../application/ports/catalog-repository.js';
import type { EpgLink } from '../../../../domain/catalog/model.js';
import type { Db } from '../database.js';
import { analyzeAfterBulkLoad } from '../maintenance.js';
import { likeTerm, tokensText } from '../search-sql.js';
import { jsonOrNull, type Database, type EpisodesTable, type LiveChannelsTable, type MoviesTable, type SeriesTable } from '../schema.js';

/** The wire protocol allows 65 535 bind parameters per statement; stay well below. */
const MAX_BIND_PARAMETERS = 60_000;

/** Inserts rows in statements that respect the parameter limit. */
async function insertChunked<T>(rows: T[], columnCount: number, insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columnCount));
  for (let offset = 0; offset < rows.length; offset += size) {
    await insert(rows.slice(offset, offset + size));
  }
}

const LIVE_SUMMARY_COLUMNS = ['key', 'position', 'name', 'groups', 'logo', 'tvg_id', 'kind', 'unplayable_reason', 'catchup', 'adult', 'xtream', 'added_at', 'epg', 'name_key'] as const;

type LiveSummaryRow = Pick<Selectable<LiveChannelsTable>, (typeof LIVE_SUMMARY_COLUMNS)[number]>;

function toLiveSummary(row: LiveSummaryRow): LiveChannelSummary {
  return {
    key: row.key,
    position: row.position,
    name: row.name,
    groups: row.groups,
    logo: row.logo,
    tvgId: row.tvg_id,
    kind: row.kind,
    unplayableReason: row.unplayable_reason,
    catchup: row.catchup,
    adult: row.adult,
    xtream: row.xtream,
    addedAt: row.added_at,
    epg: row.epg?.guideId ? row.epg : null,
    nameKey: row.name_key,
  };
}

function toLiveRow(sourceId: string, revision: number, item: StoredLiveChannel): Insertable<LiveChannelsTable> {
  return {
    source_id: sourceId,
    revision,
    key: item.key,
    position: item.position,
    name: item.name,
    groups: item.groups,
    logo: item.logo,
    tvg_id: item.tvgId,
    tvg_name: item.tvgName,
    kind: item.kind,
    unplayable_reason: item.unplayableReason,
    locator: item.locator,
    catchup: jsonOrNull(item.catchup),
    adult: item.adult,
    xtream: jsonOrNull(item.xtream),
    added_at: item.addedAt,
    epg: jsonOrNull(item.epg),
    name_key: item.nameKey,
    search_tokens: item.searchTokens,
    search: tokensText(item.searchTokens),
  };
}

function toStoredMovie(row: Selectable<MoviesTable>): StoredMovie {
  return {
    key: row.key,
    position: row.position,
    name: row.name,
    year: row.year,
    groups: row.groups,
    poster: row.poster,
    rating: row.rating,
    genres: row.genres,
    durationSecs: row.duration_secs,
    plot: row.plot,
    kind: row.kind,
    locator: row.locator,
    adult: row.adult,
    xtream: row.xtream,
    addedAt: row.added_at,
    searchTokens: row.search_tokens,
  };
}

function toStoredSeries(row: Selectable<SeriesTable>): StoredSeries {
  return {
    key: row.key,
    position: row.position,
    name: row.name,
    year: row.year,
    groups: row.groups,
    cover: row.cover,
    rating: row.rating,
    genres: row.genres,
    plot: row.plot,
    adult: row.adult,
    xtream: row.xtream,
    addedAt: row.added_at,
    searchTokens: row.search_tokens,
    detailsFetchedAt: row.details_fetched_at,
  };
}

function toStoredEpisode(row: Selectable<EpisodesTable>): StoredEpisode {
  return {
    key: row.key,
    seriesKey: row.series_key,
    season: row.season,
    episode: row.episode,
    title: row.title,
    plot: row.plot,
    durationSecs: row.duration_secs,
    still: row.still,
    airDate: row.air_date,
    kind: row.kind,
    locator: row.locator,
    xtream: row.xtream,
  };
}

export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly db: Db) {}

  async insertRevision(sourceId: string, revision: number, data: RevisionData): Promise<void> {
    // One transaction: a failed insert leaves no half-written revision behind.
    await this.db.transaction().execute(async (trx) => {
      await insertChunked(data.live, 20, (chunk) =>
        trx.insertInto('live_channels').values(chunk.map((item) => toLiveRow(sourceId, revision, item))).execute(),
      );
      await insertChunked(data.movies, 19, (chunk) =>
        trx
          .insertInto('movies')
          .values(
            chunk.map((item) => ({
              source_id: sourceId,
              revision,
              key: item.key,
              position: item.position,
              name: item.name,
              year: item.year,
              groups: item.groups,
              poster: item.poster,
              rating: item.rating,
              genres: item.genres,
              duration_secs: item.durationSecs,
              plot: item.plot,
              kind: item.kind,
              locator: item.locator,
              adult: item.adult,
              xtream: jsonOrNull(item.xtream),
              added_at: item.addedAt,
              search_tokens: item.searchTokens,
              search: tokensText(item.searchTokens),
            })),
          )
          .execute(),
      );
      await insertChunked(data.series, 17, (chunk) =>
        trx
          .insertInto('series')
          .values(
            chunk.map((item) => ({
              source_id: sourceId,
              revision,
              key: item.key,
              position: item.position,
              name: item.name,
              year: item.year,
              groups: item.groups,
              cover: item.cover,
              rating: item.rating,
              genres: item.genres,
              plot: item.plot,
              adult: item.adult,
              xtream: jsonOrNull(item.xtream),
              added_at: item.addedAt,
              search_tokens: item.searchTokens,
              search: tokensText(item.searchTokens),
              details_fetched_at: item.detailsFetchedAt,
            })),
          )
          .execute(),
      );
      await insertChunked(data.episodes, 14, (chunk) =>
        trx
          .insertInto('episodes')
          .values(
            chunk.map((item) => ({
              source_id: sourceId,
              revision,
              series_key: item.seriesKey,
              key: item.key,
              season: item.season,
              episode: item.episode,
              title: item.title,
              plot: item.plot,
              duration_secs: item.durationSecs,
              still: item.still,
              air_date: item.airDate,
              kind: item.kind,
              locator: item.locator,
              xtream: jsonOrNull(item.xtream),
            })),
          )
          .execute(),
      );
    });
    // Committed: refresh planner statistics so reads through joins are planned for the real size.
    await analyzeAfterBulkLoad(this.db, 'live_channels', data.live.length);
    await analyzeAfterBulkLoad(this.db, 'movies', data.movies.length);
    await analyzeAfterBulkLoad(this.db, 'series', data.series.length);
    await analyzeAfterBulkLoad(this.db, 'episodes', data.episodes.length);
  }

  async deleteRevision(sourceId: string, revision: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('live_channels').where('source_id', '=', sourceId).where('revision', '=', revision).execute();
      await trx.deleteFrom('movies').where('source_id', '=', sourceId).where('revision', '=', revision).execute();
      await trx.deleteFrom('series').where('source_id', '=', sourceId).where('revision', '=', revision).execute();
      await trx.deleteFrom('episodes').where('source_id', '=', sourceId).where('revision', '=', revision).execute();
    });
  }

  async deleteOtherRevisions(sourceId: string, keepRevision: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('live_channels').where('source_id', '=', sourceId).where('revision', '<>', keepRevision).execute();
      await trx.deleteFrom('movies').where('source_id', '=', sourceId).where('revision', '<>', keepRevision).execute();
      await trx.deleteFrom('series').where('source_id', '=', sourceId).where('revision', '<>', keepRevision).execute();
      await trx.deleteFrom('episodes').where('source_id', '=', sourceId).where('revision', '<>', keepRevision).execute();
    });
  }

  async deleteSource(sourceId: string): Promise<void> {
    // Normally already gone through ON DELETE CASCADE; explicit so the port holds on its own.
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('live_channels').where('source_id', '=', sourceId).execute();
      await trx.deleteFrom('movies').where('source_id', '=', sourceId).execute();
      await trx.deleteFrom('series').where('source_id', '=', sourceId).execute();
      await trx.deleteFrom('episodes').where('source_id', '=', sourceId).execute();
    });
  }

  async addedAtIndex(sourceId: string, revision: number): Promise<AddedAtIndex> {
    const [live, movies, series] = await Promise.all([
      this.db.selectFrom('live_channels').select(['key', 'added_at']).where('source_id', '=', sourceId).where('revision', '=', revision).execute(),
      this.db.selectFrom('movies').select(['key', 'added_at']).where('source_id', '=', sourceId).where('revision', '=', revision).execute(),
      this.db.selectFrom('series').select(['key', 'added_at']).where('source_id', '=', sourceId).where('revision', '=', revision).execute(),
    ]);
    const toMap = (rows: { key: string; added_at: Date | null }[]) => new Map(rows.map((row) => [row.key, row.added_at]));
    return { live: toMap(live), movies: toMap(movies), series: toMap(series) };
  }

  // --- live ---------------------------------------------------------------------------------

  async listLive(ref: SourceRevisionRef): Promise<LiveChannelSummary[]> {
    const rows = await this.db
      .selectFrom('live_channels')
      .select(LIVE_SUMMARY_COLUMNS)
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .orderBy('position')
      .execute();
    return rows.map(toLiveSummary);
  }

  async findLive(ref: SourceRevisionRef, key: string): Promise<StoredLiveChannel | null> {
    const row = await this.db.selectFrom('live_channels').selectAll().where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision).where('key', '=', key).executeTakeFirst();
    if (!row) return null;
    return { ...toLiveSummary(row), tvgName: row.tvg_name, locator: row.locator, searchTokens: row.search_tokens };
  }

  async findLiveMany(ref: SourceRevisionRef, keys: string[]): Promise<LiveChannelSummary[]> {
    if (keys.length === 0) return [];
    const rows = await this.db
      .selectFrom('live_channels')
      .select(LIVE_SUMMARY_COLUMNS)
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .where('key', 'in', keys)
      .execute();
    return rows.map(toLiveSummary);
  }

  async findLiveByNameKey(refs: SourceRevisionRef[], nameKey: string, limit: number): Promise<(LiveChannelSummary & { sourceId: string })[]> {
    if (refs.length === 0 || !nameKey) return [];
    const rows = await this.db
      .selectFrom('live_channels')
      .select([...LIVE_SUMMARY_COLUMNS, 'source_id'])
      .where('name_key', '=', nameKey)
      .where((eb) => eb.or(refs.map((ref) => eb.and([eb('source_id', '=', ref.sourceId), eb('revision', '=', ref.revision)]))))
      .limit(limit)
      .execute();
    return rows.map((row) => ({ ...toLiveSummary(row), sourceId: row.source_id }));
  }

  async liveLinkTargets(ref: SourceRevisionRef): Promise<LiveLinkTarget[]> {
    const rows = await this.db
      .selectFrom('live_channels')
      .select(['key', 'name', 'name_key', 'tvg_id', 'xtream', 'epg', 'catchup'])
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .execute();
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      nameKey: row.name_key,
      tvgId: row.tvg_id,
      xtreamEpgId: row.xtream?.epgChannelId ?? null,
      catchupDays: row.catchup?.days ?? null,
      epg: row.epg?.guideId ? row.epg : null,
    }));
  }

  async setLiveEpgLinks(ref: SourceRevisionRef, changes: { key: string; epg: EpgLink | null }[]): Promise<void> {
    for (let offset = 0; offset < changes.length; offset += 5_000) {
      const batch = changes.slice(offset, offset + 5_000);
      const keys = batch.map((change) => change.key);
      const links = batch.map((change) => (change.epg ? JSON.stringify(change.epg) : null));
      // One UPDATE per batch (unnest pairs each key with its link) instead of one per channel.
      await sql`
        UPDATE live_channels AS t
           SET epg = v.epg::jsonb
          FROM unnest(${keys}::text[], ${links}::text[]) AS v (key, epg)
         WHERE t.source_id = ${ref.sourceId}
           AND t.revision = ${ref.revision}
           AND t.key = v.key`.execute(this.db);
    }
  }

  // --- VOD ----------------------------------------------------------------------------------

  async findMovie(ref: SourceRevisionRef, key: string): Promise<StoredMovie | null> {
    const row = await this.db.selectFrom('movies').selectAll().where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision).where('key', '=', key).executeTakeFirst();
    return row ? toStoredMovie(row) : null;
  }

  async findSeries(ref: SourceRevisionRef, key: string): Promise<StoredSeries | null> {
    const row = await this.db.selectFrom('series').selectAll().where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision).where('key', '=', key).executeTakeFirst();
    return row ? toStoredSeries(row) : null;
  }

  async findEpisode(ref: SourceRevisionRef, seriesKey: string, key: string): Promise<StoredEpisode | null> {
    const row = await this.db
      .selectFrom('episodes')
      .selectAll()
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .where('series_key', '=', seriesKey)
      .where('key', '=', key)
      .executeTakeFirst();
    return row ? toStoredEpisode(row) : null;
  }

  async listEpisodes(ref: SourceRevisionRef, seriesKey: string): Promise<StoredEpisode[]> {
    const rows = await this.db
      .selectFrom('episodes')
      .selectAll()
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .where('series_key', '=', seriesKey)
      .orderBy('season')
      .orderBy('episode')
      .execute();
    return rows.map(toStoredEpisode);
  }
  async storeSeriesDetails(ref: SourceRevisionRef, seriesKey: string, details: { episodes: StoredEpisode[]; plot: string | null }, fetchedAt: Date): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Row lock: serialises with a concurrent GC of this revision (deleteOtherRevisions), so
      // episodes are never written into a revision that is being dropped.
      const series = await trx
        .selectFrom('series')
        .select('key')
        .where('source_id', '=', ref.sourceId)
        .where('revision', '=', ref.revision)
        .where('key', '=', seriesKey)
        .forUpdate()
        .executeTakeFirst();
      if (!series) return false;
      await insertChunked(details.episodes, 14, (chunk) =>
        trx
          .insertInto('episodes')
          .values(
            chunk.map((item) => ({
              source_id: ref.sourceId,
              revision: ref.revision,
              series_key: seriesKey,
              key: item.key,
              season: item.season,
              episode: item.episode,
              title: item.title,
              plot: item.plot,
              duration_secs: item.durationSecs,
              still: item.still,
              air_date: item.airDate,
              kind: item.kind,
              locator: item.locator,
              xtream: jsonOrNull(item.xtream),
            })),
          )
          .onConflict((oc) => oc.columns(['source_id', 'revision', 'series_key', 'key']).doNothing())
          .execute(),
      );
      await trx
        .updateTable('series')
        .set({ details_fetched_at: fetchedAt, plot: sql<string | null>`coalesce(plot, ${details.plot})` })
        .where('source_id', '=', ref.sourceId)
        .where('revision', '=', ref.revision)
        .where('key', '=', seriesKey)
        .execute();
      return true;
    });
  }

  // --- VOD browsing -------------------------------------------------------------------------

  async listMovies(ref: SourceRevisionRef, query: VodListQuery): Promise<{ items: MovieSummary[]; total: number }> {
    let base = this.db.selectFrom('movies').where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision);
    if (query.hideAdult) base = base.where('adult', '=', false);
    if (query.category) base = base.where('groups', '@>', sql<string[]>`ARRAY[${query.category}]::text[]`);
    const [rows, count] = await Promise.all([
      vodOrder(base.select(MOVIE_SUMMARY_COLUMNS), query.sort).limit(query.limit).offset(query.offset).execute(),
      query.skipTotal ? Promise.resolve({ total: '-1' }) : base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toMovieSummary), total: Number(count.total) };
  }

  async listSeries(ref: SourceRevisionRef, query: VodListQuery): Promise<{ items: SeriesSummary[]; total: number }> {
    let base = this.db.selectFrom('series').where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision);
    if (query.hideAdult) base = base.where('adult', '=', false);
    if (query.category) base = base.where('groups', '@>', sql<string[]>`ARRAY[${query.category}]::text[]`);
    const [rows, count] = await Promise.all([
      vodOrder(base.select(SERIES_SUMMARY_COLUMNS), query.sort).limit(query.limit).offset(query.offset).execute(),
      query.skipTotal ? Promise.resolve({ total: '-1' }) : base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toSeriesSummary), total: Number(count.total) };
  }

  async vodCategories(ref: SourceRevisionRef, type: 'movies' | 'series', hideAdult: boolean): Promise<{ name: string; count: number }[]> {
    const table = sql.table(type);
    const rows = await sql<{ name: string; count: string }>`
      SELECT g.name, count(*) AS count, min(t.position) AS first
        FROM ${table} AS t, unnest(t.groups) AS g (name)
       WHERE t.source_id = ${ref.sourceId} AND t.revision = ${ref.revision} ${hideAdult ? sql`AND t.adult = false` : sql``}
       GROUP BY g.name
       ORDER BY first
       LIMIT 500`.execute(this.db);
    return rows.rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  }

  async findMoviesMany(ref: SourceRevisionRef, keys: string[]): Promise<MovieSummary[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.selectFrom('movies').select(MOVIE_SUMMARY_COLUMNS).where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision).where('key', 'in', keys).execute();
    return rows.map(toMovieSummary);
  }

  async findSeriesMany(ref: SourceRevisionRef, keys: string[]): Promise<SeriesSummary[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.selectFrom('series').select(SERIES_SUMMARY_COLUMNS).where('source_id', '=', ref.sourceId).where('revision', '=', ref.revision).where('key', 'in', keys).execute();
    return rows.map(toSeriesSummary);
  }

  async recentlyAdded(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<RecentlyAddedRow[]> {
    if (refs.length === 0) return [];
    const pinned = (alias: string) => sql.join(refs.map((ref) => sql`(${sql.ref(`${alias}.source_id`)} = ${ref.sourceId} AND ${sql.ref(`${alias}.revision`)} = ${ref.revision})`), sql` OR `);
    const adult = (alias: string) => (hideAdult ? sql`AND ${sql.ref(`${alias}.adult`)} = false` : sql``);
    const rows = await sql<{ type: RecentlyAddedRow['type']; source_id: string; key: string; name: string; image: string | null; added_at: Date; groups: string[] }>`
      (SELECT 'channel' AS type, l.source_id, l.key, l.name, l.logo AS image, l.added_at, l.groups FROM live_channels l
        WHERE (${pinned('l')}) AND l.added_at IS NOT NULL AND l.unplayable_reason IS NULL ${adult('l')} ORDER BY l.added_at DESC LIMIT ${limit})
      UNION ALL
      (SELECT 'movie', m.source_id, m.key, m.name, m.poster, m.added_at, m.groups FROM movies m
        WHERE (${pinned('m')}) AND m.added_at IS NOT NULL ${adult('m')} ORDER BY m.added_at DESC LIMIT ${limit})
      UNION ALL
      (SELECT 'series', s.source_id, s.key, s.name, s.cover, s.added_at, s.groups FROM series s
        WHERE (${pinned('s')}) AND s.added_at IS NOT NULL ${adult('s')} ORDER BY s.added_at DESC LIMIT ${limit})
      ORDER BY added_at DESC
      LIMIT ${limit}`.execute(this.db);
    return rows.rows.map((row) => ({ type: row.type, sourceId: row.source_id, key: row.key, name: row.name, image: row.image, addedAt: row.added_at, groups: row.groups }));
  }

  async latestMovies(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<(MovieSummary & { sourceId: string })[]> {
    if (refs.length === 0) return [];
    let query = this.db.selectFrom('movies').select([...MOVIE_SUMMARY_COLUMNS, 'source_id']).where(pinnedSql(refs));
    if (hideAdult) query = query.where('adult', '=', false);
    const rows = await query.orderBy(sql`added_at DESC NULLS LAST`).orderBy(sql`rating DESC NULLS LAST`).orderBy('position').limit(limit).execute();
    return rows.map((row) => ({ ...toMovieSummary(row), sourceId: row.source_id }));
  }

  async latestSeries(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<(SeriesSummary & { sourceId: string })[]> {
    if (refs.length === 0) return [];
    let query = this.db.selectFrom('series').select([...SERIES_SUMMARY_COLUMNS, 'source_id']).where(pinnedSql(refs));
    if (hideAdult) query = query.where('adult', '=', false);
    const rows = await query.orderBy(sql`added_at DESC NULLS LAST`).orderBy(sql`rating DESC NULLS LAST`).orderBy('position').limit(limit).execute();
    return rows.map((row) => ({ ...toSeriesSummary(row), sourceId: row.source_id }));
  }

  async search(refs: SourceRevisionRef[], terms: string[], limitPerType: number, hideAdult: boolean): Promise<CatalogSearchResult> {
    if (refs.length === 0 || terms.length === 0) return { live: [], movies: [], series: [] };
    // Shortest names first: "BBC One" before "BBC One Scotland HD" for the query "bbc one".
    const live = this.db.selectFrom('live_channels').select([...LIVE_SUMMARY_COLUMNS, 'source_id']).where(pinnedSql(refs)).where('unplayable_reason', 'is', null);
    const movies = this.db.selectFrom('movies').select([...MOVIE_SUMMARY_COLUMNS, 'source_id']).where(pinnedSql(refs));
    const series = this.db.selectFrom('series').select([...SERIES_SUMMARY_COLUMNS, 'source_id']).where(pinnedSql(refs));
    let [liveQuery, movieQuery, seriesQuery] = [live, movies, series];
    for (const term of terms) {
      liveQuery = liveQuery.where('search', 'like', likeTerm(term));
      movieQuery = movieQuery.where('search', 'like', likeTerm(term));
      seriesQuery = seriesQuery.where('search', 'like', likeTerm(term));
    }
    if (hideAdult) {
      liveQuery = liveQuery.where('adult', '=', false);
      movieQuery = movieQuery.where('adult', '=', false);
      seriesQuery = seriesQuery.where('adult', '=', false);
    }
    const [liveRows, movieRows, seriesRows] = await Promise.all([
      liveQuery.orderBy(sql`length(name)`).orderBy('position').limit(limitPerType).execute(),
      movieQuery.orderBy(sql`length(name)`).orderBy(sql`rating DESC NULLS LAST`).limit(limitPerType).execute(),
      seriesQuery.orderBy(sql`length(name)`).orderBy(sql`rating DESC NULLS LAST`).limit(limitPerType).execute(),
    ]);
    return {
      live: liveRows.map((row) => ({ ...toLiveSummary(row), sourceId: row.source_id })),
      movies: movieRows.map((row) => ({ ...toMovieSummary(row), sourceId: row.source_id })),
      series: seriesRows.map((row) => ({ ...toSeriesSummary(row), sourceId: row.source_id })),
    };
  }
}

const MOVIE_SUMMARY_COLUMNS = ['key', 'position', 'name', 'year', 'groups', 'poster', 'rating', 'genres', 'duration_secs', 'plot', 'kind', 'adult', 'xtream', 'added_at'] as const;
const SERIES_SUMMARY_COLUMNS = ['key', 'position', 'name', 'year', 'groups', 'cover', 'rating', 'genres', 'plot', 'adult', 'xtream', 'added_at'] as const;

function toMovieSummary(row: Pick<Selectable<MoviesTable>, (typeof MOVIE_SUMMARY_COLUMNS)[number]>): MovieSummary {
  return {
    key: row.key,
    position: row.position,
    name: row.name,
    year: row.year,
    groups: row.groups,
    poster: row.poster,
    rating: row.rating,
    genres: row.genres,
    durationSecs: row.duration_secs,
    plot: row.plot,
    kind: row.kind,
    adult: row.adult,
    xtream: row.xtream,
    addedAt: row.added_at,
  };
}

function toSeriesSummary(row: Pick<Selectable<SeriesTable>, (typeof SERIES_SUMMARY_COLUMNS)[number]>): SeriesSummary {
  return {
    key: row.key,
    position: row.position,
    name: row.name,
    year: row.year,
    groups: row.groups,
    cover: row.cover,
    rating: row.rating,
    genres: row.genres,
    plot: row.plot,
    adult: row.adult,
    xtream: row.xtream,
    addedAt: row.added_at,
  };
}

/** `recent`: provider/first-seen date, then provider order (stable paging: position is unique). */
function vodOrder<Q extends SelectQueryBuilder<Database, 'movies' | 'series', object>>(query: Q, sort: VodSortOrder): Q {
  switch (sort) {
    case 'name':
      return query.orderBy(sql`lower(name)`).orderBy('position') as Q;
    case 'rating':
      return query.orderBy(sql`rating DESC NULLS LAST`).orderBy('position') as Q;
    case 'year':
      return query.orderBy(sql`year DESC NULLS LAST`).orderBy('position') as Q;
    default:
      return query.orderBy(sql`added_at DESC NULLS LAST`).orderBy('position') as Q;
  }
}

/** `(source_id, revision)` is one of the pinned revisions (unqualified columns: single-table queries). */
function pinnedSql(refs: SourceRevisionRef[]) {
  return sql<boolean>`(${sql.join(
    refs.map((ref) => sql`(source_id = ${ref.sourceId} AND revision = ${ref.revision})`),
    sql` OR `,
  )})`;
}
