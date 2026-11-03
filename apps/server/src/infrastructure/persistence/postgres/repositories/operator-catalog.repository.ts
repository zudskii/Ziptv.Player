import { sql, type Kysely, type Selectable } from 'kysely';

import type {
  CategoryRecord,
  FeedRecord,
  LineupRecord,
  MasterChannelRecord,
  NewGrant,
  OperatorCatalogRepository,
  ProviderRecord,
  ProviderStats,
  ProviderStreamRecord,
  StoredGrant,
  StreamUpsert,
} from '../../../../application/ports/operator.js';
import type { AliasKind, MatchMethod, ProviderStatus, ProviderType, StreamStatus } from '../../../../domain/operator/catalog.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import { likeTerm, searchText } from '../search-sql.js';
import { json, jsonOrNull, type ChannelMasterTable, type Database, type ProviderStreamsTable, type RightsGrantsTable } from '../schema.js';
import { queryTerms } from '../../../../domain/shared/text.js';

const CHUNK = 500;

type ProviderRow = Selectable<Database['providers']> & { secret_ref: string | null; rotated_at: Date | null };

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    type: row.integration_type,
    config: row.config,
    host: row.host,
    syncIntervalHours: row.sync_interval_hours,
    sync: {
      status: row.sync_status,
      lastAttemptAt: row.sync_last_attempt_at,
      lastSuccessAt: row.sync_last_success_at,
      nextAt: row.sync_next_at,
      error: row.sync_error,
      failures: row.sync_failures,
    },
    stats: row.stats,
    credential: row.secret_ref ? { secretRef: row.secret_ref, rotatedAt: row.rotated_at ?? row.created_at } : null,
    createdAt: row.created_at,
  };
}

function toStream(row: Selectable<ProviderStreamsTable>): ProviderStreamRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    externalId: row.external_id,
    name: row.name,
    tvgId: row.tvg_id,
    groups: row.groups,
    logo: row.logo,
    kind: row.kind,
    locator: row.locator,
    xtream: row.xtream,
    status: row.status,
    channelId: row.channel_id,
    matchMethod: row.match_method,
    suggestion: row.suggestion,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toChannel(row: Selectable<ChannelMasterTable>): MasterChannelRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    originCountry: row.origin_country,
    languages: row.languages,
    categoryId: row.category_id,
    logo: row.logo,
    globalUid: row.global_uid,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGrant(row: Selectable<RightsGrantsTable>): StoredGrant {
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

const aliasId = (kind: AliasKind, key: string) => `${kind}\u0000${key}`;

/**
 * Operator catalog on PostgreSQL. Constructed with the pool for reads and background sync, or
 * with a transaction inside the admin unit of work (audited writes). `mergeChannels` must run in a
 * transaction (the admin unit of work provides one).
 */
export class PgOperatorCatalogRepository implements OperatorCatalogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  newId(): string {
    return newEntityId();
  }

  // --- providers -------------------------------------------------------------------------------

  private providerQuery() {
    return this.db
      .selectFrom('providers as p')
      .leftJoin('provider_credentials as c', 'c.provider_id', 'p.id')
      .selectAll('p')
      .select(['c.secret_ref', 'c.rotated_at']);
  }

  async listProviders(): Promise<ProviderRecord[]> {
    return (await this.providerQuery().orderBy('p.name').execute()).map(toProvider);
  }

  async findProvider(id: string): Promise<ProviderRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.providerQuery().where('p.id', '=', id).executeTakeFirst();
    return row ? toProvider(row) : null;
  }

  async createProvider(input: { id: string; slug: string; name: string; type: ProviderType; config: Record<string, unknown>; host: string; syncIntervalHours: number; secretRef: string | null }): Promise<ProviderRecord> {
    await this.db
      .insertInto('providers')
      .values({ id: input.id, slug: input.slug, name: input.name, status: 'active', integration_type: input.type, config: json(input.config), host: input.host, sync_interval_hours: input.syncIntervalHours, sync_next_at: new Date() })
      .execute();
    if (input.secretRef) await this.db.insertInto('provider_credentials').values({ provider_id: input.id, secret_ref: input.secretRef }).execute();
    return (await this.findProvider(input.id))!;
  }

  async updateProvider(id: string, patch: { name?: string; status?: ProviderStatus; config?: Record<string, unknown>; host?: string; syncIntervalHours?: number }): Promise<ProviderRecord | null> {
    if (!isEntityId(id)) return null;
    const result = await this.db
      .updateTable('providers')
      .set({
        updated_at: new Date(),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.config !== undefined ? { config: json(patch.config) } : {}),
        ...(patch.host !== undefined ? { host: patch.host } : {}),
        ...(patch.syncIntervalHours !== undefined ? { sync_interval_hours: patch.syncIntervalHours } : {}),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n ? this.findProvider(id) : null;
  }

  async setCredential(id: string, secretRef: string, now: Date): Promise<void> {
    await this.db
      .insertInto('provider_credentials')
      .values({ provider_id: id, secret_ref: secretRef, rotated_at: now })
      .onConflict((conflict) => conflict.column('provider_id').doUpdateSet({ secret_ref: secretRef, rotated_at: now }))
      .execute();
  }

  async requestProviderSync(id: string, now: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('providers')
      .set({ sync_status: sql`CASE WHEN sync_status = 'running' THEN 'running' ELSE 'queued' END`, sync_next_at: now, updated_at: now })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async claimDueProvider(now: Date, owner: string, leaseUntil: Date): Promise<ProviderRecord | null> {
    const claimed = await sql<{ id: string }>`
      UPDATE providers SET lease_owner = ${owner}, lease_until = ${leaseUntil}, sync_status = 'running', sync_last_attempt_at = ${now}, updated_at = ${now}
      WHERE id = (
        SELECT id FROM providers
        WHERE status = 'active'
          AND (lease_until IS NULL OR lease_until < ${now})
          AND (sync_status IN ('queued', 'running') OR sync_next_at <= ${now})
        ORDER BY sync_next_at NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`.execute(this.db);
    const row = claimed.rows[0];
    return row ? this.findProvider(row.id) : null;
  }

  async heartbeatProvider(id: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.db.updateTable('providers').set({ lease_until: leaseUntil }).where('id', '=', id).where('lease_owner', '=', owner).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async completeProviderSync(id: string, owner: string, result: { ok: boolean; error: string | null; stats?: ProviderStats; nextAt: Date; now: Date }): Promise<void> {
    await this.db
      .updateTable('providers')
      .set({
        // A sync requested while this one ran (next_at moved past the attempt start) stays queued.
        sync_status: sql`CASE WHEN sync_next_at > sync_last_attempt_at THEN 'queued' ELSE ${result.ok ? 'idle' : 'failed'} END`,
        sync_error: result.error,
        sync_next_at: sql`CASE WHEN sync_next_at > sync_last_attempt_at THEN sync_next_at ELSE ${result.nextAt} END`,
        lease_owner: null,
        lease_until: null,
        updated_at: result.now,
        ...(result.ok ? { sync_last_success_at: result.now, sync_failures: 0 } : { sync_failures: sql<number>`sync_failures + 1` }),
        ...(result.stats ? { stats: json(result.stats) } : {}),
      })
      .where('id', '=', id)
      .where('lease_owner', '=', owner)
      .execute();
  }

  // --- streams ---------------------------------------------------------------------------------

  async listStreams(providerId: string): Promise<ProviderStreamRecord[]> {
    return (await this.db.selectFrom('provider_streams').selectAll().where('provider_id', '=', providerId).execute()).map(toStream);
  }

  async findStream(id: string, options: { lock?: boolean } = {}): Promise<ProviderStreamRecord | null> {
    if (!isEntityId(id)) return null;
    const query = this.db.selectFrom('provider_streams').selectAll().where('id', '=', id);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toStream(row) : null;
  }

  async upsertStreams(providerId: string, streams: StreamUpsert[], now: Date): Promise<Map<string, ProviderStreamRecord>> {
    const result = new Map<string, ProviderStreamRecord>();
    for (let offset = 0; offset < streams.length; offset += CHUNK) {
      const chunk = streams.slice(offset, offset + CHUNK);
      const rows = await this.db
        .insertInto('provider_streams')
        .values(
          chunk.map((stream) => ({
            id: newEntityId(),
            provider_id: providerId,
            external_id: stream.externalId,
            name: stream.name,
            tvg_id: stream.tvgId,
            groups: stream.groups,
            logo: stream.logo,
            kind: stream.kind,
            locator: stream.locator,
            xtream: jsonOrNull(stream.xtream),
            first_seen_at: now,
            last_seen_at: now,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['provider_id', 'external_id']).doUpdateSet((eb) => ({
            name: eb.ref('excluded.name'),
            tvg_id: eb.ref('excluded.tvg_id'),
            groups: eb.ref('excluded.groups'),
            logo: eb.ref('excluded.logo'),
            kind: eb.ref('excluded.kind'),
            locator: eb.ref('excluded.locator'),
            xtream: eb.ref('excluded.xtream'),
            last_seen_at: now,
            // A stream that comes back resumes its previous state.
            status: sql<StreamStatus>`CASE WHEN provider_streams.status = 'gone' THEN (CASE WHEN provider_streams.channel_id IS NULL THEN 'pending' ELSE 'matched' END) ELSE provider_streams.status END`,
          })),
        )
        .returningAll()
        .execute();
      for (const row of rows) result.set(row.external_id, toStream(row));
    }
    return result;
  }

  async markGone(providerId: string, seenBefore: Date): Promise<number> {
    const result = await this.db
      .updateTable('provider_streams')
      .set({ status: 'gone' })
      .where('provider_id', '=', providerId)
      .where('last_seen_at', '<', seenBefore)
      .where('status', '<>', 'gone')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async setStreamState(id: string, patch: { status: StreamStatus; channelId?: string | null; matchMethod?: MatchMethod | null; suggestion?: string | null }, expected?: StreamStatus): Promise<boolean> {
    let query = this.db
      .updateTable('provider_streams')
      .set({
        status: patch.status,
        ...(patch.channelId !== undefined ? { channel_id: patch.channelId } : {}),
        ...(patch.matchMethod !== undefined ? { match_method: patch.matchMethod } : {}),
        ...(patch.suggestion !== undefined ? { suggestion: patch.suggestion } : {}),
      })
      .where('id', '=', id);
    if (expected) query = query.where('status', '=', expected);
    const result = await query.executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async reviewQueue(query: { providerId?: string | undefined; status: StreamStatus; offset: number; limit: number }): Promise<{ items: ProviderStreamRecord[]; total: number }> {
    let base = this.db.selectFrom('provider_streams').where('status', '=', query.status);
    if (query.providerId) base = base.where('provider_id', '=', query.providerId);
    const [rows, count] = await Promise.all([
      base.selectAll().orderBy('first_seen_at').orderBy('name').offset(query.offset).limit(query.limit).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toStream), total: Number(count.count) };
  }

  async providerStats(providerId: string): Promise<ProviderStats> {
    const rows = await this.db
      .selectFrom('provider_streams')
      .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
      .where('provider_id', '=', providerId)
      .groupBy('status')
      .execute();
    const by = new Map(rows.map((row) => [row.status, Number(row.count)]));
    return {
      streams: (by.get('pending') ?? 0) + (by.get('matched') ?? 0) + (by.get('ignored') ?? 0),
      matched: by.get('matched') ?? 0,
      pending: by.get('pending') ?? 0,
      gone: by.get('gone') ?? 0,
    };
  }

  // --- channels & aliases ----------------------------------------------------------------------

  async listCategories(): Promise<CategoryRecord[]> {
    return this.db.selectFrom('categories').select(['id', 'slug', 'name']).orderBy('name').execute();
  }

  async createCategory(input: { id: string; slug: string; name: string }): Promise<CategoryRecord> {
    await this.db.insertInto('categories').values(input).execute();
    return input;
  }

  async listChannels(query: { text?: string | undefined; status?: 'active' | 'hidden' | undefined; offset: number; limit: number }): Promise<{ items: MasterChannelRecord[]; total: number }> {
    let base = this.db.selectFrom('channel_master');
    if (query.status) base = base.where('status', '=', query.status);
    for (const term of queryTerms(query.text ?? '')) base = base.where('search', 'like', likeTerm(term));
    const [rows, count] = await Promise.all([
      base.selectAll().orderBy('name').orderBy('id').offset(query.offset).limit(query.limit).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toChannel), total: Number(count.count) };
  }

  async findChannel(id: string): Promise<MasterChannelRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('channel_master').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toChannel(row) : null;
  }

  async findChannels(ids: string[]): Promise<MasterChannelRecord[]> {
    const valid = ids.filter(isEntityId);
    if (valid.length === 0) return [];
    return (await this.db.selectFrom('channel_master').selectAll().where('id', 'in', valid).execute()).map(toChannel);
  }

  async slugExists(slug: string): Promise<boolean> {
    return Boolean(await this.db.selectFrom('channel_master').select('id').where('slug', '=', slug).executeTakeFirst());
  }

  async createChannel(input: Omit<MasterChannelRecord, 'createdAt' | 'updatedAt'>): Promise<MasterChannelRecord> {
    const row = await this.db
      .insertInto('channel_master')
      .values({
        id: input.id,
        slug: input.slug,
        name: input.name,
        origin_country: input.originCountry,
        languages: input.languages,
        category_id: input.categoryId,
        logo: input.logo,
        global_uid: input.globalUid,
        status: input.status,
        search: searchText(input.name),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toChannel(row);
  }

  async updateChannel(id: string, patch: Partial<Omit<MasterChannelRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<MasterChannelRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('channel_master')
      .set({
        updated_at: new Date(),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.name !== undefined ? { name: patch.name, search: searchText(patch.name) } : {}),
        ...(patch.originCountry !== undefined ? { origin_country: patch.originCountry } : {}),
        ...(patch.languages !== undefined ? { languages: patch.languages } : {}),
        ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {}),
        ...(patch.logo !== undefined ? { logo: patch.logo } : {}),
        ...(patch.globalUid !== undefined ? { global_uid: patch.globalUid } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toChannel(row) : null;
  }

  async channelsByAlias(keys: { kind: AliasKind; key: string }[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (let offset = 0; offset < keys.length; offset += CHUNK) {
      const chunk = keys.slice(offset, offset + CHUNK);
      const rows = await this.db
        .selectFrom('channel_aliases')
        .select(['kind', 'key', 'channel_id'])
        .where((eb) => eb.or(chunk.map((alias) => eb.and([eb('kind', '=', alias.kind), eb('key', '=', alias.key)]))))
        .execute();
      for (const row of rows) result.set(aliasId(row.kind, row.key), row.channel_id);
    }
    return result;
  }

  async addAliases(channelId: string, keys: { kind: AliasKind; key: string }[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db
      .insertInto('channel_aliases')
      .values(keys.map((alias) => ({ kind: alias.kind, key: alias.key, channel_id: channelId })))
      .onConflict((conflict) => conflict.columns(['kind', 'key']).doNothing())
      .execute();
  }

  async aliasesOf(channelId: string): Promise<{ kind: AliasKind; key: string }[]> {
    return this.db.selectFrom('channel_aliases').select(['kind', 'key']).where('channel_id', '=', channelId).orderBy('kind').orderBy('key').execute();
  }

  async mergeChannels(fromId: string, intoId: string): Promise<void> {
    await sql`UPDATE channel_aliases SET channel_id = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`UPDATE channel_feeds SET channel_id = ${intoId}, updated_at = now() WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`UPDATE provider_streams SET channel_id = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`UPDATE provider_streams SET suggestion = ${intoId} WHERE suggestion = ${fromId}`.execute(this.db);
    await sql`UPDATE rights_grants SET channel_id = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    // A lineup listing both keeps the surviving channel's number.
    await sql`DELETE FROM lineup_channels f USING lineup_channels i WHERE f.channel_id = ${fromId} AND i.channel_id = ${intoId} AND f.lineup_id = i.lineup_id`.execute(this.db);
    await sql`UPDATE lineup_channels SET channel_id = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`INSERT INTO operator_favorites (profile_id, channel_id, added_at) SELECT profile_id, ${intoId}, added_at FROM operator_favorites WHERE channel_id = ${fromId} ON CONFLICT DO NOTHING`.execute(this.db);
    await sql`UPDATE history SET channel_id = ${intoId}, key = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`UPDATE failover_events SET channel_id = ${intoId} WHERE channel_id = ${fromId}`.execute(this.db);
    await sql`DELETE FROM channel_master WHERE id = ${fromId}`.execute(this.db);
  }

  // --- feeds -----------------------------------------------------------------------------------

  private feedQuery() {
    return this.db
      .selectFrom('channel_feeds as f')
      .innerJoin('providers as p', 'p.id', 'f.provider_id')
      .innerJoin('provider_streams as s', 's.id', 'f.provider_stream_id')
      .select(['f.id', 'f.channel_id', 'f.provider_id', 'f.provider_stream_id', 'f.priority', 'f.status', 'f.created_at', 'p.status as provider_status', 's.status as stream_status']);
  }

  private static toFeed(row: { id: string; channel_id: string; provider_id: string; provider_stream_id: string; priority: number; status: 'active' | 'disabled'; created_at: Date; provider_status: ProviderStatus; stream_status: StreamStatus }): FeedRecord {
    return {
      id: row.id,
      channelId: row.channel_id,
      providerId: row.provider_id,
      providerStreamId: row.provider_stream_id,
      priority: row.priority,
      status: row.status,
      createdAt: row.created_at,
      providerStatus: row.provider_status,
      streamStatus: row.stream_status,
    };
  }

  async feedsOf(channelIds: string[]): Promise<FeedRecord[]> {
    if (channelIds.length === 0) return [];
    const rows = await this.feedQuery().where('f.channel_id', 'in', channelIds).orderBy('f.priority').orderBy('f.created_at').execute();
    return rows.map(PgOperatorCatalogRepository.toFeed);
  }

  async createFeed(input: { id: string; channelId: string; providerId: string; providerStreamId: string; priority: number }): Promise<FeedRecord> {
    await this.db
      .insertInto('channel_feeds')
      .values({ id: input.id, channel_id: input.channelId, provider_id: input.providerId, provider_stream_id: input.providerStreamId, priority: input.priority })
      // A concurrent decision (sync vs. console) already created it: the existing feed stands.
      .onConflict((conflict) => conflict.column('provider_stream_id').doNothing())
      .execute();
    return (await this.findFeedByStream(input.providerStreamId))!;
  }

  async findFeedByStream(providerStreamId: string): Promise<FeedRecord | null> {
    const row = await this.feedQuery().where('f.provider_stream_id', '=', providerStreamId).executeTakeFirst();
    return row ? PgOperatorCatalogRepository.toFeed(row) : null;
  }

  async findFeed(id: string): Promise<FeedRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.feedQuery().where('f.id', '=', id).executeTakeFirst();
    return row ? PgOperatorCatalogRepository.toFeed(row) : null;
  }

  async updateFeed(id: string, patch: { priority?: number; status?: 'active' | 'disabled' }): Promise<FeedRecord | null> {
    if (!isEntityId(id)) return null;
    await this.db
      .updateTable('channel_feeds')
      .set({ updated_at: new Date(), ...(patch.priority !== undefined ? { priority: patch.priority } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}) })
      .where('id', '=', id)
      .execute();
    return this.findFeed(id);
  }

  async deleteFeed(id: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    return (await this.db.deleteFrom('channel_feeds').where('id', '=', id).executeTakeFirst()).numDeletedRows > 0n;
  }

  // --- rights ----------------------------------------------------------------------------------

  async grantsOf(channelIds: string[]): Promise<StoredGrant[]> {
    if (channelIds.length === 0) return [];
    const rows = await this.db.selectFrom('rights_grants').selectAll().where('channel_id', 'in', channelIds).orderBy('created_at').execute();
    return rows.map(toGrant);
  }

  async findGrant(id: string): Promise<StoredGrant | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('rights_grants').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toGrant(row) : null;
  }

  async createGrant(input: NewGrant): Promise<StoredGrant> {
    const row = await this.db
      .insertInto('rights_grants')
      .values({
        id: input.id,
        channel_id: input.channelId,
        territory: input.territory,
        device_classes: input.deviceClasses,
        business_models: input.businessModels,
        start_at: input.startAt,
        end_at: input.endAt,
        contract_ref: input.contractRef,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toGrant(row);
  }

  async revokeGrant(id: string, now: Date): Promise<StoredGrant | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.updateTable('rights_grants').set({ status: 'revoked', revoked_at: now }).where('id', '=', id).where('status', '=', 'active').returningAll().executeTakeFirst();
    return row ? toGrant(row) : null;
  }

  // --- lineups ---------------------------------------------------------------------------------

  private lineupQuery() {
    return this.db
      .selectFrom('lineups as l')
      .selectAll('l')
      .select((eb) => eb.selectFrom('lineup_channels as c').select((inner) => inner.fn.countAll<string>().as('n')).whereRef('c.lineup_id', '=', 'l.id').as('channels'));
  }

  private static toLineup(row: Selectable<Database['lineups']> & { channels: string | null }): LineupRecord {
    return { id: row.id, slug: row.slug, name: row.name, country: row.country, status: row.status, channels: Number(row.channels ?? 0) };
  }

  async listLineups(): Promise<LineupRecord[]> {
    return (await this.lineupQuery().orderBy('l.country').orderBy('l.name').execute()).map(PgOperatorCatalogRepository.toLineup);
  }

  async findLineup(idOrSlug: string): Promise<LineupRecord | null> {
    const row = await this.lineupQuery()
      .where(isEntityId(idOrSlug) ? 'l.id' : 'l.slug', '=', idOrSlug)
      .executeTakeFirst();
    return row ? PgOperatorCatalogRepository.toLineup(row) : null;
  }

  async createLineup(input: { id: string; slug: string; name: string; country: string; status: 'draft' | 'active' }): Promise<LineupRecord> {
    await this.db.insertInto('lineups').values(input).execute();
    return (await this.findLineup(input.id))!;
  }

  async updateLineup(id: string, patch: { name?: string; status?: 'draft' | 'active' }): Promise<LineupRecord | null> {
    if (!isEntityId(id)) return null;
    await this.db
      .updateTable('lineups')
      .set({ updated_at: new Date(), ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}) })
      .where('id', '=', id)
      .execute();
    return this.findLineup(id);
  }

  async lineupEntries(lineupId: string): Promise<{ channelId: string; number: number }[]> {
    const rows = await this.db.selectFrom('lineup_channels').select(['channel_id', 'number']).where('lineup_id', '=', lineupId).orderBy('number').execute();
    return rows.map((row) => ({ channelId: row.channel_id, number: row.number }));
  }

  async setLineupEntries(lineupId: string, entries: { channelId: string; number: number }[]): Promise<void> {
    await this.db.deleteFrom('lineup_channels').where('lineup_id', '=', lineupId).execute();
    for (let offset = 0; offset < entries.length; offset += CHUNK) {
      await this.db
        .insertInto('lineup_channels')
        .values(entries.slice(offset, offset + CHUNK).map((entry) => ({ lineup_id: lineupId, channel_id: entry.channelId, number: entry.number })))
        .execute();
    }
  }

  async lineupsForCountry(country: string): Promise<LineupRecord[]> {
    return (await this.lineupQuery().where('l.country', '=', country).where('l.status', '=', 'active').orderBy('l.name').execute()).map(PgOperatorCatalogRepository.toLineup);
  }

  // --- viewer ----------------------------------------------------------------------------------

  async activeChannelsWithFeeds(): Promise<MasterChannelRecord[]> {
    const rows = await this.db
      .selectFrom('channel_master as m')
      .selectAll('m')
      .where('m.status', '=', 'active')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('channel_feeds as f')
            .innerJoin('providers as p', 'p.id', 'f.provider_id')
            .innerJoin('provider_streams as s', 's.id', 'f.provider_stream_id')
            .select('f.id')
            .whereRef('f.channel_id', '=', 'm.id')
            .where('f.status', '=', 'active')
            .where('p.status', '=', 'active')
            .where('s.status', '=', 'matched'),
        ),
      )
      .orderBy('m.name')
      .execute();
    return rows.map(toChannel);
  }

  async favorites(profileId: string): Promise<{ channelId: string; addedAt: Date }[]> {
    const rows = await this.db.selectFrom('operator_favorites').select(['channel_id', 'added_at']).where('profile_id', '=', profileId).orderBy('added_at', 'desc').execute();
    return rows.map((row) => ({ channelId: row.channel_id, addedAt: row.added_at }));
  }

  async addFavorite(profileId: string, channelId: string): Promise<void> {
    await this.db.insertInto('operator_favorites').values({ profile_id: profileId, channel_id: channelId }).onConflict((conflict) => conflict.columns(['profile_id', 'channel_id']).doNothing()).execute();
  }

  async removeFavorite(profileId: string, channelId: string): Promise<boolean> {
    return (await this.db.deleteFrom('operator_favorites').where('profile_id', '=', profileId).where('channel_id', '=', channelId).executeTakeFirst()).numDeletedRows > 0n;
  }
}
