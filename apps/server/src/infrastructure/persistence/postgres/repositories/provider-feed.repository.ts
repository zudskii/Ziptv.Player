import { sql, type Kysely, type Selectable } from 'kysely';

import type { StoredGrant } from '../../../../application/ports/operator.js';
import type {
  FeedGrantSpec,
  NewSyncEvent,
  ProviderContentSummary,
  ProviderFeedRepository,
  ProviderSyncEvent,
  SealedVod,
  VodCatalogItem,
  VodCatalogQuery,
} from '../../../../application/ports/provider-feed-repository.js';
import type { FeedRight } from '../../../../domain/operator/vendor-feed.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import { json, type Database, type RightsGrantsTable, type StoredFeedRight } from '../schema.js';

const CHUNK = 500;
/** Journal entries kept per provider (a sync with many skipped items writes a summary, not one row each). */
const JOURNAL_RETENTION = 500;

const toStoredRights = (rights: readonly FeedRight[]): StoredFeedRight[] =>
  rights.map((right) => ({ ...right, start: right.start.toISOString(), end: right.end?.toISOString() ?? null }));
const fromStoredRights = (rights: readonly StoredFeedRight[]): FeedRight[] =>
  rights.map((right) => ({ ...right, start: new Date(right.start), end: right.end ? new Date(right.end) : null, maxQuality: right.maxQuality ?? null }));

/** Identity of a grant's licence terms (what "the same grant" means when the feed is re-applied). */
const grantKey = (grant: Pick<FeedGrantSpec, 'territory' | 'deviceClasses' | 'businessModels' | 'startAt' | 'endAt' | 'catchupDays' | 'maxQuality'>) =>
  [grant.territory, [...grant.deviceClasses].sort().join('+'), [...grant.businessModels].sort().join('+'), grant.startAt.getTime(), grant.endAt?.getTime() ?? '', grant.catchupDays, grant.maxQuality ?? ''].join('|');

export class PgProviderFeedRepository implements ProviderFeedRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async recordEvents(providerId: string, events: readonly NewSyncEvent[], at: Date): Promise<void> {
    if (events.length === 0) return;
    await this.db
      .insertInto('provider_sync_events')
      .values(events.map((event, index) => ({ id: newEntityId(), provider_id: providerId, at: new Date(at.getTime() + index), level: event.level, code: event.code, message: event.message, details: json(event.details ?? {}) })))
      .execute();
    await sql`
      DELETE FROM provider_sync_events
       WHERE provider_id = ${providerId}
         AND id IN (SELECT id FROM provider_sync_events WHERE provider_id = ${providerId} ORDER BY at DESC OFFSET ${JOURNAL_RETENTION})`.execute(this.db);
  }

  async events(providerId: string, limit: number): Promise<ProviderSyncEvent[]> {
    const rows = await this.db.selectFrom('provider_sync_events').selectAll().where('provider_id', '=', providerId).orderBy('at', 'desc').limit(limit).execute();
    return rows.map((row) => ({ id: row.id, providerId: row.provider_id, at: row.at, level: row.level, code: row.code, message: row.message, details: row.details }));
  }

  async setFeedPosition(providerId: string, cursor: string, generatedAt: Date): Promise<void> {
    await this.db.updateTable('providers').set({ sync_cursor: cursor, feed_generated_at: generatedAt }).where('id', '=', providerId).execute();
  }

  async setStreamRights(providerId: string, rights: ReadonlyMap<string, FeedRight[] | null>): Promise<void> {
    const entries = [...rights];
    for (let offset = 0; offset < entries.length; offset += CHUNK) {
      const chunk = entries.slice(offset, offset + CHUNK);
      await sql`
        UPDATE provider_streams AS s SET rights = v.rights::jsonb
          FROM unnest(${chunk.map(([id]) => id)}::text[], ${chunk.map(([, value]) => (value === null ? null : JSON.stringify(toStoredRights(value))))}::text[]) AS v (external_id, rights)
         WHERE s.provider_id = ${providerId} AND s.external_id = v.external_id`.execute(this.db);
    }
  }

  async markStreamsGone(providerId: string, externalIds: readonly string[]): Promise<number> {
    if (externalIds.length === 0) return 0;
    const result = await this.db.updateTable('provider_streams').set({ status: 'gone' }).where('provider_id', '=', providerId).where('external_id', 'in', [...externalIds]).where('status', '<>', 'gone').executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async upsertVod(providerId: string, items: readonly SealedVod[], now: Date): Promise<void> {
    for (let offset = 0; offset < items.length; offset += CHUNK) {
      const chunk = items.slice(offset, offset + CHUNK);
      await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .insertInto('provider_vod')
          .values(
            chunk.map((item) => ({
              id: newEntityId(),
              provider_id: providerId,
              external_id: item.externalId,
              type: item.type,
              title: item.title,
              year: item.year,
              genres: item.genres,
              genre_ids: item.genreIds,
              poster: item.poster,
              plot: item.plot,
              duration_secs: item.durationSecs,
              rating: item.rating,
              locator: item.locator,
              rights: json(toStoredRights(item.rights)),
              packages: item.packages,
              first_seen_at: now,
              last_seen_at: now,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(['provider_id', 'external_id']).doUpdateSet((eb) => ({
              type: eb.ref('excluded.type'),
              title: eb.ref('excluded.title'),
              year: eb.ref('excluded.year'),
              genres: eb.ref('excluded.genres'),
              genre_ids: eb.ref('excluded.genre_ids'),
              poster: eb.ref('excluded.poster'),
              plot: eb.ref('excluded.plot'),
              duration_secs: eb.ref('excluded.duration_secs'),
              rating: eb.ref('excluded.rating'),
              locator: eb.ref('excluded.locator'),
              rights: eb.ref('excluded.rights'),
              packages: eb.ref('excluded.packages'),
              status: 'active',
              last_seen_at: now,
            })),
          )
          .returning(['id', 'external_id'])
          .execute();
        const ids = new Map(rows.map((row) => [row.external_id, row.id]));
        // Episodes are replaced with what the feed says (a series item always carries its full list).
        const vodIds = chunk.map((item) => ids.get(item.externalId)!).filter(Boolean);
        if (vodIds.length) await trx.deleteFrom('provider_episodes').where('vod_id', 'in', vodIds).execute();
        const episodes = chunk.flatMap((item) => item.episodes.map((episode) => ({ vod_id: ids.get(item.externalId)!, external_id: episode.externalId, season: episode.season, episode: episode.episode, title: episode.title, duration_secs: episode.durationSecs, locator: episode.locator })));
        for (let at = 0; at < episodes.length; at += CHUNK) {
          await trx.insertInto('provider_episodes').values(episodes.slice(at, at + CHUNK)).onConflict((conflict) => conflict.doNothing()).execute();
        }
      });
    }
  }

  async markVodGone(providerId: string, which: { externalIds: readonly string[] } | { seenBefore: Date }): Promise<number> {
    let query = this.db.updateTable('provider_vod').set({ status: 'gone' }).where('provider_id', '=', providerId).where('status', '<>', 'gone');
    if ('externalIds' in which) {
      if (which.externalIds.length === 0) return 0;
      query = query.where('external_id', 'in', [...which.externalIds]);
    } else {
      query = query.where('last_seen_at', '<', which.seenBefore);
    }
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  }

  async upsertPackages(providerId: string, packages: readonly { externalId: string; name: string; description: string | null }[], now: Date): Promise<void> {
    if (packages.length === 0) return;
    await this.db
      .insertInto('provider_packages')
      .values(packages.map((item) => ({ id: newEntityId(), provider_id: providerId, external_id: item.externalId, name: item.name, description: item.description, updated_at: now })))
      .onConflict((conflict) => conflict.columns(['provider_id', 'external_id']).doUpdateSet((eb) => ({ name: eb.ref('excluded.name'), description: eb.ref('excluded.description'), status: 'active', updated_at: now })))
      .execute();
  }

  async markPackagesGone(providerId: string, which: { externalIds: readonly string[] } | { seenBefore: Date }): Promise<number> {
    let query = this.db.updateTable('provider_packages').set({ status: 'gone' }).where('provider_id', '=', providerId).where('status', '<>', 'gone');
    if ('externalIds' in which) {
      if (which.externalIds.length === 0) return 0;
      query = query.where('external_id', 'in', [...which.externalIds]);
    } else {
      query = query.where('updated_at', '<', which.seenBefore);
    }
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  }

  async content(providerId: string): Promise<ProviderContentSummary> {
    const [counts, episodes, packages, recent] = await Promise.all([
      this.db.selectFrom('provider_vod').select(['type', (eb) => eb.fn.countAll<string>().as('n')]).where('provider_id', '=', providerId).where('status', '=', 'active').groupBy('type').execute(),
      sql<{ n: string }>`SELECT count(*) AS n FROM provider_episodes e JOIN provider_vod v ON v.id = e.vod_id WHERE v.provider_id = ${providerId} AND v.status = 'active'`.execute(this.db),
      sql<{ external_id: string; name: string; status: 'active' | 'gone'; items: string }>`
        SELECT p.external_id, p.name, p.status,
               (SELECT count(*) FROM provider_vod v WHERE v.provider_id = p.provider_id AND v.status = 'active' AND p.external_id = ANY(v.packages)) AS items
          FROM provider_packages p WHERE p.provider_id = ${providerId} ORDER BY p.status, p.name LIMIT 200`.execute(this.db),
      this.db.selectFrom('provider_vod').select(['external_id', 'type', 'title', 'year', 'status']).where('provider_id', '=', providerId).orderBy('last_seen_at', 'desc').orderBy('title').limit(20).execute(),
    ]);
    const count = (type: string) => Number(counts.find((row) => row.type === type)?.n ?? 0);
    return {
      movies: count('movie'),
      series: count('series'),
      episodes: Number(episodes.rows[0]?.n ?? 0),
      packages: packages.rows.map((row) => ({ externalId: row.external_id, name: row.name, status: row.status, items: Number(row.items) })),
      recent: recent.map((row) => ({ externalId: row.external_id, type: row.type, title: row.title, year: row.year, status: row.status })),
    };
  }

  async packageOptions(): Promise<{ id: string; providerId: string; providerName: string; name: string; items: number; status: 'active' | 'gone' }[]> {
    const rows = await sql<{ id: string; provider_id: string; provider_name: string; name: string; status: 'active' | 'gone'; items: string }>`
      SELECT p.id, p.provider_id, pr.name AS provider_name, p.name, p.status,
             (SELECT count(*) FROM provider_vod v WHERE v.provider_id = p.provider_id AND v.status = 'active' AND p.external_id = ANY(v.packages)) AS items
        FROM provider_packages p JOIN providers pr ON pr.id = p.provider_id
       ORDER BY p.status, pr.name, p.name LIMIT 1000`.execute(this.db);
    return rows.rows.map((row) => ({ id: row.id, providerId: row.provider_id, providerName: row.provider_name, name: row.name, items: Number(row.items), status: row.status }));
  }

  async vodCatalog(query: VodCatalogQuery): Promise<{ items: VodCatalogItem[]; total: number }> {
    const country = query.country ?? '';
    const at = query.at.toISOString();
    // A right that covers the viewer now under a sellable model (the exact rule runs again in the domain).
    const licensed = sql<boolean>`EXISTS (
      SELECT 1 FROM jsonb_array_elements(v.rights) r
       WHERE (r->'territories' ? '*' OR r->'territories' ? ${country})
         AND r->'devices' ? ${query.device}
         AND (r->'models' ? 'subscription' OR r->'models' ? 'b2b')
         AND (r->>'start')::timestamptz <= ${at}::timestamptz
         AND (r->>'end' IS NULL OR (r->>'end')::timestamptz > ${at}::timestamptz))`;
    const type = query.type ? sql`AND v.type = ${query.type}` : sql``;
    const text = query.q?.trim() ? sql`AND v.title ILIKE ${`%${query.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`} ESCAPE '\\'` : sql``;
    const [rows, total] = await Promise.all([
      sql<{ id: string; provider_id: string; type: 'movie' | 'series'; title: string; year: number | null; poster: string | null; genres: string[]; rating: number | null; rights: StoredFeedRight[]; package_ids: string[] }>`
        SELECT v.id, v.provider_id, v.type, v.title, v.year, v.poster, v.genres, v.rating, v.rights,
               ARRAY(SELECT pp.id FROM provider_packages pp WHERE pp.provider_id = v.provider_id AND pp.status = 'active' AND pp.external_id = ANY(v.packages)) AS package_ids
          FROM provider_vod v JOIN providers p ON p.id = v.provider_id
         WHERE v.status = 'active' AND p.status = 'active' AND ${licensed} ${type} ${text}
         ORDER BY v.title, v.id
         LIMIT ${query.limit} OFFSET ${query.offset}`.execute(this.db),
      sql<{ n: string }>`
        SELECT count(*) AS n FROM provider_vod v JOIN providers p ON p.id = v.provider_id
         WHERE v.status = 'active' AND p.status = 'active' AND ${licensed} ${type} ${text}`.execute(this.db),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        type: row.type,
        title: row.title,
        year: row.year,
        poster: row.poster,
        genres: row.genres,
        rating: row.rating === null ? null : Number(row.rating),
        rights: fromStoredRights(row.rights),
        packageIds: row.package_ids,
      })),
      total: Number(total.rows[0]?.n ?? 0),
    };
  }

  async vodItem(id: string): Promise<Awaited<ReturnType<ProviderFeedRepository['vodItem']>>> {
    if (!isEntityId(id)) return null;
    const row = await sql<{ id: string; provider_id: string; type: 'movie' | 'series'; title: string; year: number | null; poster: string | null; genres: string[]; rating: number | null; rights: StoredFeedRight[]; package_ids: string[]; plot: string | null; duration_secs: number | null; locator: string | null }>`
      SELECT v.id, v.provider_id, v.type, v.title, v.year, v.poster, v.genres, v.rating, v.rights, v.plot, v.duration_secs, v.locator,
             ARRAY(SELECT pp.id FROM provider_packages pp WHERE pp.provider_id = v.provider_id AND pp.status = 'active' AND pp.external_id = ANY(v.packages)) AS package_ids
        FROM provider_vod v JOIN providers p ON p.id = v.provider_id
       WHERE v.id = ${id} AND v.status = 'active' AND p.status = 'active'`.execute(this.db);
    const item = row.rows[0];
    if (!item) return null;
    const episodes = await this.db.selectFrom('provider_episodes').selectAll().where('vod_id', '=', id).orderBy('season').orderBy('episode').execute();
    return {
      id: item.id,
      providerId: item.provider_id,
      type: item.type,
      title: item.title,
      year: item.year,
      poster: item.poster,
      genres: item.genres,
      rating: item.rating === null ? null : Number(item.rating),
      rights: fromStoredRights(item.rights),
      packageIds: item.package_ids,
      plot: item.plot,
      durationSecs: item.duration_secs,
      locator: item.locator,
      episodes: episodes.map((episode) => ({ externalId: episode.external_id, season: episode.season, episode: episode.episode, title: episode.title, durationSecs: episode.duration_secs, locator: episode.locator })),
    };
  }

  async feedChannels(providerId: string): Promise<string[]> {
    const rows = await sql<{ channel_id: string }>`
      SELECT DISTINCT channel_id FROM provider_streams WHERE provider_id = ${providerId} AND channel_id IS NOT NULL AND rights IS NOT NULL
      UNION
      SELECT DISTINCT channel_id FROM rights_grants WHERE provider_id = ${providerId} AND origin = 'feed' AND status = 'active'`.execute(this.db);
    return rows.rows.map((row) => row.channel_id);
  }

  async streamRightsOfChannel(channelId: string): Promise<{ providerId: string; rights: FeedRight[] | null }[]> {
    const rows = await this.db
      .selectFrom('provider_streams as s')
      .innerJoin('providers as p', 'p.id', 's.provider_id')
      .select(['s.provider_id', 's.rights'])
      .where('s.channel_id', '=', channelId)
      .where('s.status', '=', 'matched')
      .where('p.status', '=', 'active')
      .execute();
    // One provider may carry a channel in several streams: their rights add up.
    const byProvider = new Map<string, FeedRight[] | null>();
    for (const row of rows) {
      const rights = row.rights ? fromStoredRights(row.rights) : null;
      const current = byProvider.get(row.provider_id);
      byProvider.set(row.provider_id, current === undefined ? rights : rights === null ? current : [...(current ?? []), ...rights]);
    }
    return [...byProvider].map(([providerId, rights]) => ({ providerId, rights }));
  }

  async replaceFeedGrants(channelId: string, providerId: string, contractRef: string, grants: readonly FeedGrantSpec[], now: Date): Promise<{ added: number; revoked: StoredGrant[] }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('rights_grants')
        .selectAll()
        .where('channel_id', '=', channelId)
        .where('provider_id', '=', providerId)
        .where('origin', '=', 'feed')
        .where('status', '=', 'active')
        .forUpdate()
        .execute();
      const wanted = new Map(grants.map((grant) => [grantKey(grant), grant]));
      const have = new Map(existing.map((row) => [grantKey({ territory: row.territory, deviceClasses: row.device_classes, businessModels: row.business_models, startAt: row.start_at, endAt: row.end_at, catchupDays: row.catchup_days, maxQuality: row.max_quality }), row]));
      const stale = [...have].filter(([key]) => !wanted.has(key)).map(([, row]) => row.id);
      const fresh = [...wanted].filter(([key]) => !have.has(key)).map(([, grant]) => grant);
      const revoked = stale.length ? await trx.updateTable('rights_grants').set({ status: 'revoked', revoked_at: now }).where('id', 'in', stale).returningAll().execute() : [];
      if (fresh.length) {
        await trx
          .insertInto('rights_grants')
          .values(
            fresh.map((grant) => ({
              id: newEntityId(),
              channel_id: channelId,
              territory: grant.territory,
              device_classes: [...grant.deviceClasses],
              business_models: [...grant.businessModels],
              start_at: grant.startAt,
              end_at: grant.endAt,
              contract_ref: contractRef,
              catchup_days: grant.catchupDays,
              max_quality: grant.maxQuality,
              origin: 'feed' as const,
              provider_id: providerId,
              created_by: null,
            })),
          )
          .execute();
      }
      return { added: fresh.length, revoked: revoked.map(toStoredGrant) };
    });
  }
}

function toStoredGrant(row: Selectable<RightsGrantsTable>): StoredGrant {
  return {
    id: row.id,
    channelId: row.channel_id,
    territory: row.territory,
    deviceClasses: row.device_classes,
    businessModels: row.business_models,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    contractRef: row.contract_ref,
    catchupDays: row.catchup_days,
    maxQuality: row.max_quality,
    origin: row.origin,
    providerId: row.provider_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
