import { sql, type Selectable } from 'kysely';

import type {
  HistoryKind,
  HistoryPageQuery,
  HistoryRecord,
  HistoryRepository,
  ListItemKind,
  ListItemRecord,
  ListRepository,
  ProgressRecord,
  ProgressRef,
  ProgressRepository,
} from '../../../../application/ports/user-state-repository.js';
import type { Db } from '../database.js';
import type { HistoryTable, ListItemsTable, ProgressTable } from '../schema.js';

const deleted = (result: { numDeletedRows: bigint }) => Number(result.numDeletedRows);

// ---------------------------------------------------------------------------------------------
// My List
// ---------------------------------------------------------------------------------------------

function toListItem(row: Selectable<ListItemsTable>): ListItemRecord {
  return {
    profileId: row.profile_id,
    sourceId: row.source_id,
    type: row.type,
    key: row.key,
    title: row.title,
    subtitle: row.subtitle,
    image: row.image,
    addedAt: row.added_at,
  };
}

export class PgListRepository implements ListRepository {
  constructor(private readonly db: Db) {}

  async add(item: Omit<ListItemRecord, 'addedAt'>): Promise<ListItemRecord> {
    const row = await this.db
      .insertInto('list_items')
      .values({ profile_id: item.profileId, source_id: item.sourceId, type: item.type, key: item.key, title: item.title, subtitle: item.subtitle, image: item.image })
      // Re-adding refreshes the snapshot but keeps the original date (list order).
      .onConflict((conflict) =>
        conflict.columns(['profile_id', 'source_id', 'type', 'key']).doUpdateSet({ title: item.title, subtitle: item.subtitle, image: item.image }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toListItem(row);
  }

  async remove(profileId: string, sourceId: string, type: ListItemKind, key: string): Promise<boolean> {
    const result = await this.db.deleteFrom('list_items').where('profile_id', '=', profileId).where('source_id', '=', sourceId).where('type', '=', type).where('key', '=', key).executeTakeFirst();
    return deleted(result) > 0;
  }

  async list(profileId: string, limit: number): Promise<ListItemRecord[]> {
    const rows = await this.db.selectFrom('list_items').selectAll().where('profile_id', '=', profileId).orderBy('added_at', 'desc').orderBy('key').limit(limit).execute();
    return rows.map(toListItem);
  }

  async keys(profileId: string, sourceId: string, type: ListItemKind): Promise<Set<string>> {
    const rows = await this.db.selectFrom('list_items').select('key').where('profile_id', '=', profileId).where('source_id', '=', sourceId).where('type', '=', type).execute();
    return new Set(rows.map((row) => row.key));
  }

  async clear(profileId: string): Promise<number> {
    return deleted(await this.db.deleteFrom('list_items').where('profile_id', '=', profileId).executeTakeFirst());
  }

  async count(profileId: string): Promise<number> {
    const row = await this.db.selectFrom('list_items').select((eb) => eb.fn.countAll<string>().as('count')).where('profile_id', '=', profileId).executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

function toProgress(row: Selectable<ProgressTable>): ProgressRecord {
  return {
    profileId: row.profile_id,
    sourceId: row.source_id,
    contentType: row.content_type,
    seriesKey: row.series_key,
    key: row.key,
    season: row.season,
    episode: row.episode,
    title: row.title,
    seriesTitle: row.series_title,
    image: row.image,
    position: row.position,
    duration: row.duration,
    completed: row.completed,
    updatedAt: row.updated_at,
  };
}

export class PgProgressRepository implements ProgressRepository {
  constructor(private readonly db: Db) {}

  async find(ref: ProgressRef): Promise<ProgressRecord | null> {
    const row = await this.db
      .selectFrom('progress')
      .selectAll()
      .where('profile_id', '=', ref.profileId)
      .where('source_id', '=', ref.sourceId)
      .where('content_type', '=', ref.contentType)
      .where('series_key', '=', ref.seriesKey)
      .where('key', '=', ref.key)
      .executeTakeFirst();
    return row ? toProgress(row) : null;
  }

  async save(record: Omit<ProgressRecord, 'updatedAt'>, now: Date): Promise<void> {
    const values = {
      season: record.season,
      episode: record.episode,
      title: record.title,
      series_title: record.seriesTitle,
      image: record.image,
      position: record.position,
      duration: record.duration,
      completed: record.completed,
      updated_at: now,
    };
    await this.db
      .insertInto('progress')
      .values({ profile_id: record.profileId, source_id: record.sourceId, content_type: record.contentType, series_key: record.seriesKey, key: record.key, ...values })
      .onConflict((conflict) => conflict.columns(['profile_id', 'source_id', 'content_type', 'series_key', 'key']).doUpdateSet(values))
      .execute();
  }

  async listRecent(profileId: string, limit: number): Promise<ProgressRecord[]> {
    const rows = await this.db.selectFrom('progress').selectAll().where('profile_id', '=', profileId).where('completed', '=', false).orderBy('updated_at', 'desc').limit(limit).execute();
    return rows.map(toProgress);
  }

  async listForSeries(profileId: string, sourceId: string, seriesKey: string): Promise<ProgressRecord[]> {
    const rows = await this.db
      .selectFrom('progress')
      .selectAll()
      .where('profile_id', '=', profileId)
      .where('source_id', '=', sourceId)
      .where('content_type', '=', 'episode')
      .where('series_key', '=', seriesKey)
      .execute();
    return rows.map(toProgress);
  }

  async listForMovies(profileId: string, sourceId: string, keys: string[]): Promise<ProgressRecord[]> {
    if (keys.length === 0) return [];
    const rows = await this.db
      .selectFrom('progress')
      .selectAll()
      .where('profile_id', '=', profileId)
      .where('source_id', '=', sourceId)
      .where('content_type', '=', 'movie')
      .where('series_key', '=', '')
      .where('key', 'in', keys)
      .execute();
    return rows.map(toProgress);
  }

  async remove(ref: ProgressRef): Promise<boolean> {
    const result = await this.db
      .deleteFrom('progress')
      .where('profile_id', '=', ref.profileId)
      .where('source_id', '=', ref.sourceId)
      .where('content_type', '=', ref.contentType)
      .where('series_key', '=', ref.seriesKey)
      .where('key', '=', ref.key)
      .executeTakeFirst();
    return deleted(result) > 0;
  }

  async clear(profileId: string): Promise<number> {
    return deleted(await this.db.deleteFrom('progress').where('profile_id', '=', profileId).executeTakeFirst());
  }

  async count(profileId: string): Promise<number> {
    const row = await this.db.selectFrom('progress').select((eb) => eb.fn.countAll<string>().as('count')).where('profile_id', '=', profileId).executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

function toHistory(row: Selectable<HistoryTable>): HistoryRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceId: row.source_id,
    contentType: row.content_type,
    key: row.key,
    seriesKey: row.series_key,
    season: row.season,
    episode: row.episode,
    title: row.title,
    subtitle: row.subtitle,
    seriesTitle: row.series_title,
    image: row.image,
    startedAt: row.started_at,
    watchedAt: row.watched_at,
    watchedSecs: row.watched_secs,
    programmeStart: row.programme_start,
    programmeEnd: row.programme_end,
  };
}

export class PgHistoryRepository implements HistoryRepository {
  constructor(private readonly db: Db) {}

  async start(record: Omit<HistoryRecord, 'startedAt' | 'watchedAt' | 'watchedSecs'>, now: Date, initialSecs = 0): Promise<void> {
    await this.db
      .insertInto('history')
      .values({
        id: record.id,
        profile_id: record.profileId,
        source_id: record.sourceId,
        content_type: record.contentType,
        key: record.key,
        series_key: record.seriesKey,
        season: record.season,
        episode: record.episode,
        title: record.title,
        subtitle: record.subtitle,
        series_title: record.seriesTitle,
        image: record.image,
        started_at: now,
        watched_at: now,
        watched_secs: initialSecs,
        programme_start: record.programmeStart,
        programme_end: record.programmeEnd,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
  }

  async touch(id: string, profileId: string, now: Date, maxCreditSecs: number): Promise<HistoryRecord | null> {
    const row = await this.db
      .updateTable('history')
      .set({
        watched_secs: sql<number>`watched_secs + LEAST(GREATEST(EXTRACT(EPOCH FROM (${now}::timestamptz - watched_at)), 0), ${maxCreditSecs})`,
        watched_at: sql<Date>`GREATEST(watched_at, ${now}::timestamptz)`,
      })
      .where('id', '=', id)
      .where('profile_id', '=', profileId)
      .returningAll()
      .executeTakeFirst();
    return row ? toHistory(row) : null;
  }

  async find(id: string, profileId: string): Promise<HistoryRecord | null> {
    const row = await this.db.selectFrom('history').selectAll().where('id', '=', id).where('profile_id', '=', profileId).executeTakeFirst();
    return row ? toHistory(row) : null;
  }

  async page(profileId: string, query: HistoryPageQuery): Promise<HistoryRecord[]> {
    let select = this.db.selectFrom('history').selectAll().where('profile_id', '=', profileId).where('watched_secs', '>=', query.minSecs);
    if (query.before) {
      const { watchedAt, id } = query.before;
      select = select.where((eb) => eb.or([eb('watched_at', '<', watchedAt), eb.and([eb('watched_at', '=', watchedAt), eb('id', '<', id)])]));
    }
    const rows = await select.orderBy('watched_at', 'desc').orderBy('id', 'desc').limit(query.limit).execute();
    return rows.map(toHistory);
  }

  async recentDistinct(profileId: string, limit: number, minSecs: number, types?: HistoryKind[]): Promise<HistoryRecord[]> {
    let inner = this.db
      .selectFrom('history')
      .selectAll()
      .distinctOn(['source_id', 'content_type', 'series_key', 'key'])
      .where('profile_id', '=', profileId)
      .where('watched_secs', '>=', minSecs)
      .where('watched_at', '>', sql<Date>`now() - interval '90 days'`);
    if (types?.length) inner = inner.where('content_type', 'in', types);
    const rows = await this.db
      .selectFrom(inner.orderBy('source_id').orderBy('content_type').orderBy('series_key').orderBy('key').orderBy('watched_at', 'desc').as('latest'))
      .selectAll()
      .orderBy('watched_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toHistory);
  }

  async remove(id: string, profileId: string): Promise<boolean> {
    return deleted(await this.db.deleteFrom('history').where('id', '=', id).where('profile_id', '=', profileId).executeTakeFirst()) > 0;
  }

  async clear(profileId: string): Promise<number> {
    return deleted(await this.db.deleteFrom('history').where('profile_id', '=', profileId).executeTakeFirst());
  }

  async count(profileId: string, minSecs: number): Promise<number> {
    const row = await this.db
      .selectFrom('history')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('profile_id', '=', profileId)
      .where('watched_secs', '>=', minSecs)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async prune(now: Date, defaultRetentionDays: number, minSecs: number): Promise<number> {
    const retention = sql`COALESCE((p.settings -> 'data' ->> 'historyRetentionDays')::int, ${defaultRetentionDays})`;
    const expired = await sql`
      DELETE FROM history h
       USING profiles p
       WHERE h.profile_id = p.id
         AND ${retention} > 0
         AND h.watched_at < ${now}::timestamptz - make_interval(days => ${retention})`.execute(this.db);
    // Zapping leftovers (viewings too short to be listed) are only kept for a day.
    const zapping = await this.db
      .deleteFrom('history')
      .where('watched_secs', '<', minSecs)
      .where('watched_at', '<', new Date(now.getTime() - 24 * 3600_000))
      .executeTakeFirst();
    return Number(expired.numAffectedRows ?? 0n) + deleted(zapping);
  }
}
