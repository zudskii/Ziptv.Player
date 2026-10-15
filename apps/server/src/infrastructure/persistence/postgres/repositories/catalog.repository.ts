import { sql, type Insertable, type Selectable } from 'kysely';

import type {
  AddedAtIndex,
  CatalogRepository,
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
import { jsonOrNull, type EpisodesTable, type LiveChannelsTable, type MoviesTable, type SeriesTable } from '../schema.js';

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
      await insertChunked(data.live, 19, (chunk) =>
        trx.insertInto('live_channels').values(chunk.map((item) => toLiveRow(sourceId, revision, item))).execute(),
      );
      await insertChunked(data.movies, 18, (chunk) =>
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
            })),
          )
          .execute(),
      );
      await insertChunked(data.series, 16, (chunk) =>
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
              details_fetched_at: null,
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
      .select(['key', 'name', 'name_key', 'tvg_id', 'xtream', 'epg'])
      .where('source_id', '=', ref.sourceId)
      .where('revision', '=', ref.revision)
      .execute();
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      nameKey: row.name_key,
      tvgId: row.tvg_id,
      xtreamEpgId: row.xtream?.epgChannelId ?? null,
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
}
