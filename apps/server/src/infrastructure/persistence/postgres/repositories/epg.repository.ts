import { sql, type Selectable } from 'kysely';

import type {
  EpgMappingRecord,
  EpgMappingRepository,
  GuideChannelRecord,
  GuideChannelRepository,
  GuideRecord,
  GuideRef,
  GuideRepository,
  GuideStats,
  NewGuide,
  ProgrammeQuery,
  ProgrammeRecord,
  ProgrammeRepository,
} from '../../../../application/ports/epg-repository.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import type { Db } from '../database.js';
import { likeTerm, searchText } from '../search-sql.js';
import { json, type GuidesTable, type ProgrammesTable, type StoredGuideStats } from '../schema.js';

/** Rows per INSERT: 13 columns × 2 000 stays far below PostgreSQL's 65 535 parameters. */
const INSERT_BATCH = 2_000;

/** ' token token ' — a term matches a token prefix with LIKE '% term%'. */
/** The generation a guide currently shows (sub-select for "never delete the live rows"). */
function liveGeneration(guideId: string) {
  return sql<number>`(SELECT generation FROM guides WHERE id = ${guideId}::uuid)`;
}

// ---------------------------------------------------------------------------------------------
// guides
// ---------------------------------------------------------------------------------------------

type GuideRow = Selectable<GuidesTable> & { source_ids: string[] | null; claimed_generation?: number };

function toStats(stats: StoredGuideStats | null | undefined): GuideStats {
  return {
    channels: stats?.channels ?? 0,
    keptChannels: stats?.keptChannels ?? 0,
    programmes: stats?.programmes ?? 0,
    from: stats?.from ? new Date(stats.from) : null,
    to: stats?.to ? new Date(stats.to) : null,
  };
}

function toGuide(row: GuideRow): GuideRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    origin: row.origin,
    url: row.url,
    urlHash: row.url_hash,
    host: row.host,
    sourceIds: (row.source_ids ?? []).filter(Boolean),
    generation: row.generation,
    ...(row.claimed_generation !== undefined ? { claimedGeneration: row.claimed_generation } : {}),
    sync: {
      status: row.sync_status,
      lastAttemptAt: row.sync_last_attempt_at,
      lastSuccessAt: row.sync_last_success_at,
      nextSyncAt: row.sync_next_at,
      error: row.sync_error,
      consecutiveFailures: row.sync_failures,
      rerunRequested: row.sync_rerun,
    },
    stats: toStats(row.stats),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgGuideRepository implements GuideRepository {
  constructor(private readonly db: Db) {}

  /** Guides with the ids of the sources they apply to. */
  private select() {
    return this.db
      .selectFrom('guides as g')
      .selectAll('g')
      .select(sql<string[]>`coalesce((SELECT array_agg(gs.source_id::text ORDER BY gs.source_id) FROM guide_sources gs WHERE gs.guide_id = g.id), '{}')`.as('source_ids'));
  }

  isValidId(id: string): boolean {
    return isEntityId(id);
  }

  async listByOwner(ownerId: string): Promise<GuideRecord[]> {
    return (await this.select().where('g.owner_id', '=', ownerId).orderBy('g.created_at').execute()).map(toGuide);
  }

  async listForSource(ownerId: string, sourceId: string): Promise<GuideRecord[]> {
    if (!isEntityId(sourceId)) return [];
    const rows = await this.select()
      .where('g.owner_id', '=', ownerId)
      .where((eb) => eb.exists(eb.selectFrom('guide_sources as gs').select('gs.guide_id').whereRef('gs.guide_id', '=', 'g.id').where('gs.source_id', '=', sourceId)))
      .orderBy('g.created_at')
      .execute();
    return rows.map(toGuide);
  }

  async findOwned(id: string, ownerId: string): Promise<GuideRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.select().where('g.id', '=', id).where('g.owner_id', '=', ownerId).executeTakeFirst();
    return row ? toGuide(row) : null;
  }

  async findById(id: string): Promise<GuideRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.select().where('g.id', '=', id).executeTakeFirst();
    return row ? toGuide(row) : null;
  }

  async findByUrlHash(ownerId: string, urlHash: string): Promise<GuideRecord | null> {
    const row = await this.select().where('g.owner_id', '=', ownerId).where('g.url_hash', '=', urlHash).executeTakeFirst();
    return row ? toGuide(row) : null;
  }

  async create(guide: NewGuide): Promise<GuideRecord> {
    const id = newEntityId();
    const createdId = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('guides')
        .values({
          id,
          owner_id: guide.ownerId,
          name: guide.name,
          origin: guide.origin,
          url: guide.url,
          url_hash: guide.urlHash,
          host: guide.host,
          sync_status: 'queued',
          sync_last_attempt_at: null,
          sync_last_success_at: null,
          sync_next_at: guide.queuedAt,
          sync_error: null,
          lease_owner: null,
          lease_until: null,
        })
        // Two sources announcing the same URL at once: one row, both attached.
        .onConflict((oc) => oc.columns(['owner_id', 'url_hash']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const guideId = inserted?.id ?? (await trx.selectFrom('guides').select('id').where('owner_id', '=', guide.ownerId).where('url_hash', '=', guide.urlHash).executeTakeFirstOrThrow()).id;
      if (guide.sourceIds.length > 0) {
        await trx.insertInto('guide_sources').values(guide.sourceIds.map((sourceId) => ({ guide_id: guideId, source_id: sourceId }))).onConflict((oc) => oc.doNothing()).execute();
      }
      return guideId;
    });
    return (await this.findById(createdId))!;
  }

  async update(id: string, ownerId: string, patch: { name?: string; sourceIds?: string[] }): Promise<GuideRecord | null> {
    if (!isEntityId(id)) return null;
    const updated = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('guides')
        .set({ updated_at: new Date(), ...(patch.name !== undefined ? { name: patch.name } : {}) })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      if (patch.sourceIds !== undefined) {
        await trx.deleteFrom('guide_sources').where('guide_id', '=', id).execute();
        // Only the owner's own sources can be attached.
        if (patch.sourceIds.length > 0) {
          await sql`
            INSERT INTO guide_sources (guide_id, source_id)
            SELECT ${id}::uuid, s.id FROM sources s WHERE s.owner_id = ${ownerId}::uuid AND s.id = ANY(${patch.sourceIds}::uuid[])
            ON CONFLICT DO NOTHING`.execute(trx);
        }
      }
      return true;
    });
    return updated ? this.findById(id) : null;
  }

  async attachSource(id: string, sourceId: string): Promise<void> {
    await this.db.insertInto('guide_sources').values({ guide_id: id, source_id: sourceId }).onConflict((oc) => oc.doNothing()).execute();
  }

  async detachSource(ownerId: string, sourceId: string, guideIds?: string[]): Promise<void> {
    if (guideIds && guideIds.length === 0) return;
    let query = this.db
      .deleteFrom('guide_sources')
      .where('source_id', '=', sourceId)
      .where('guide_id', 'in', (eb) => eb.selectFrom('guides').select('id').where('owner_id', '=', ownerId));
    if (guideIds) query = query.where('guide_id', 'in', guideIds);
    await query.execute();
  }

  async listOrphans(ownerId: string): Promise<GuideRecord[]> {
    const rows = await this.select()
      .where('g.owner_id', '=', ownerId)
      .where('g.origin', '!=', 'manual')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('guide_sources as gs').select('gs.guide_id').whereRef('gs.guide_id', '=', 'g.id'))))
      .execute();
    return rows.map(toGuide);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('guides').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async requestSync(id: string, now: Date): Promise<GuideRecord | null> {
    if (!isEntityId(id)) return null;
    // One statement: not running → queue it; running → ask the run to start over when it finishes.
    await sql`
      UPDATE guides SET
        sync_rerun   = (lease_until IS NOT NULL AND lease_until >= ${now}),
        sync_status  = CASE WHEN lease_until IS NOT NULL AND lease_until >= ${now} THEN sync_status ELSE 'queued' END,
        sync_next_at = CASE WHEN lease_until IS NOT NULL AND lease_until >= ${now} THEN sync_next_at ELSE ${now} END,
        updated_at   = ${now}
      WHERE id = ${id}::uuid`.execute(this.db);
    return this.findById(id);
  }

  async claimDue(now: Date, owner: string, leaseUntil: Date): Promise<GuideRecord | null> {
    // Each run reserves its own generation number, so a run whose lease lapsed can never write
    // into (or delete) the rows of the run that took over.
    const claimed = await sql<{ id: string; next_generation: number }>`
      UPDATE guides SET lease_owner = ${owner}, lease_until = ${leaseUntil}, sync_status = 'running',
        sync_last_attempt_at = ${now}, sync_rerun = false, updated_at = ${now},
        next_generation = greatest(next_generation, generation) + 1
      WHERE id = (
        SELECT id FROM guides
        WHERE (lease_until IS NULL OR lease_until < ${now})
          AND (sync_status IN ('queued', 'running') OR sync_next_at <= ${now})
        ORDER BY sync_next_at NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, next_generation`.execute(this.db);
    const row = claimed.rows[0];
    if (!row) return null;
    const guide = await this.findById(row.id);
    return guide ? { ...guide, claimedGeneration: row.next_generation } : null;
  }

  async heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.db.updateTable('guides').set({ lease_until: leaseUntil }).where('id', '=', id).where('lease_owner', '=', owner).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async commitGeneration(id: string, owner: string, expectedGeneration: number, generation: number, stats: GuideStats): Promise<GuideRecord | null> {
    const stored: StoredGuideStats = { ...stats, from: stats.from?.toISOString() ?? null, to: stats.to?.toISOString() ?? null };
    const row = await this.db
      .updateTable('guides')
      .set({ generation, stats: json(stored), updated_at: new Date() })
      .where('id', '=', id)
      .where('generation', '=', expectedGeneration)
      .where('lease_owner', '=', owner)
      .returning('id')
      .executeTakeFirst();
    return row ? this.findById(id) : null;
  }

  async completeSync(
    id: string,
    owner: string,
    outcome: { status: 'idle' | 'failed'; error: string | null; nextSyncAt: Date; consecutiveFailures: number; lastSuccessAt?: Date },
  ): Promise<GuideRecord | null> {
    const row = await this.db
      .updateTable('guides')
      .set({
        sync_status: outcome.status,
        sync_error: outcome.error,
        sync_next_at: outcome.nextSyncAt,
        sync_failures: outcome.consecutiveFailures,
        lease_owner: null,
        lease_until: null,
        updated_at: new Date(),
        ...(outcome.lastSuccessAt ? { sync_last_success_at: outcome.lastSuccessAt } : {}),
      })
      .where('id', '=', id)
      .where('lease_owner', '=', owner)
      .returning(['id', 'sync_rerun'])
      .executeTakeFirst();
    if (!row) return null;
    if (row.sync_rerun) {
      await this.db.updateTable('guides').set({ sync_status: 'queued', sync_next_at: new Date(), sync_rerun: false }).where('id', '=', id).where('lease_owner', 'is', null).execute();
    }
    return this.findById(id);
  }
}

// ---------------------------------------------------------------------------------------------
// guide channels
// ---------------------------------------------------------------------------------------------

export class PgGuideChannelRepository implements GuideChannelRepository {
  constructor(private readonly db: Db) {}

  async insertGeneration(ref: GuideRef, channels: GuideChannelRecord[]): Promise<void> {
    for (let offset = 0; offset < channels.length; offset += INSERT_BATCH) {
      const chunk = channels.slice(offset, offset + INSERT_BATCH);
      await this.db
        .insertInto('guide_channels')
        .values(
          chunk.map((channel) => ({
            guide_id: ref.guideId,
            generation: ref.generation,
            id: channel.id,
            names: channel.names,
            icon: channel.icon,
            kept: channel.kept,
            search: searchText(channel.id.replace(/[._-]+/g, ' '), ...channel.names),
          })),
        )
        // XMLTV files sometimes declare a channel twice: the first declaration wins.
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }

  async deleteGeneration(ref: GuideRef): Promise<void> {
    // Never the live generation, whatever a confused caller asks.
    await this.db.deleteFrom('guide_channels').where('guide_id', '=', ref.guideId).where('generation', '=', ref.generation).where('generation', '!=', liveGeneration(ref.guideId)).execute();
  }

  async deleteOtherGenerations(ref: GuideRef): Promise<void> {
    await this.db.deleteFrom('guide_channels').where('guide_id', '=', ref.guideId).where('generation', '!=', ref.generation).execute();
  }

  async deleteGuide(guideId: string): Promise<void> {
    await this.db.deleteFrom('guide_channels').where('guide_id', '=', guideId).execute();
  }

  async list(ref: GuideRef): Promise<GuideChannelRecord[]> {
    return this.db
      .selectFrom('guide_channels')
      .select(['id', 'names', 'icon', 'kept'])
      .where('guide_id', '=', ref.guideId)
      .where('generation', '=', ref.generation)
      .execute();
  }

  async find(ref: GuideRef, ids: string[]): Promise<GuideChannelRecord[]> {
    if (ids.length === 0) return [];
    return this.db
      .selectFrom('guide_channels')
      .select(['id', 'names', 'icon', 'kept'])
      .where('guide_id', '=', ref.guideId)
      .where('generation', '=', ref.generation)
      .where(sql<boolean>`id = ANY(${ids}::text[])`)
      .execute();
  }

  async search(refs: GuideRef[], terms: string[], limit: number): Promise<(GuideChannelRecord & { guideId: string })[]> {
    if (refs.length === 0) return [];
    let query = this.db
      .selectFrom('guide_channels')
      .select(['guide_id', 'id', 'names', 'icon', 'kept'])
      .where((eb) => eb.or(refs.map((ref) => eb.and([eb('guide_id', '=', ref.guideId), eb('generation', '=', ref.generation)]))));
    for (const term of terms) query = query.where('search', 'like', likeTerm(term));
    const rows = await query.orderBy('id').limit(limit).execute();
    return rows.map((row) => ({ guideId: row.guide_id, id: row.id, names: row.names, icon: row.icon, kept: row.kept }));
  }
}

// ---------------------------------------------------------------------------------------------
// programmes
// ---------------------------------------------------------------------------------------------

function toProgramme(row: Selectable<ProgrammesTable>): ProgrammeRecord & { guideId: string } {
  return {
    guideId: row.guide_id,
    channelId: row.channel_id,
    start: row.start_at,
    stop: row.stop_at,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    categories: row.categories,
    icon: row.icon,
    episode: row.episode,
    rating: row.rating,
  };
}

export class PgProgrammeRepository implements ProgrammeRepository {
  constructor(private readonly db: Db) {}

  async insertGeneration(ref: GuideRef, programmes: ProgrammeRecord[]): Promise<void> {
    for (let offset = 0; offset < programmes.length; offset += INSERT_BATCH) {
      const chunk = programmes.slice(offset, offset + INSERT_BATCH);
      await this.db
        .insertInto('programmes')
        .values(
          chunk.map((programme) => ({
            guide_id: ref.guideId,
            generation: ref.generation,
            channel_id: programme.channelId,
            start_at: programme.start,
            stop_at: programme.stop,
            title: programme.title,
            subtitle: programme.subtitle,
            description: programme.description,
            categories: programme.categories,
            icon: programme.icon,
            episode: programme.episode,
            rating: programme.rating,
            search: searchText(programme.title, programme.subtitle),
          })),
        )
        .execute();
    }
  }

  async deleteGeneration(ref: GuideRef): Promise<void> {
    await this.db.deleteFrom('programmes').where('guide_id', '=', ref.guideId).where('generation', '=', ref.generation).where('generation', '!=', liveGeneration(ref.guideId)).execute();
  }

  async deleteOtherGenerations(ref: GuideRef): Promise<void> {
    await this.db.deleteFrom('programmes').where('guide_id', '=', ref.guideId).where('generation', '!=', ref.generation).execute();
  }

  async deleteGuide(guideId: string): Promise<void> {
    await this.db.deleteFrom('programmes').where('guide_id', '=', guideId).execute();
  }

  async window(queries: ProgrammeQuery[], from: Date, to: Date): Promise<(ProgrammeRecord & { guideId: string })[]> {
    const branches = queries.filter((query) => query.channelIds.length > 0);
    if (branches.length === 0) return [];
    const rows = await this.db
      .selectFrom('programmes')
      .selectAll()
      .where((eb) =>
        eb.or(branches.map((query) => eb.and([eb('guide_id', '=', query.guideId), eb('generation', '=', query.generation), sql<boolean>`channel_id = ANY(${query.channelIds}::text[])`]))),
      )
      .where('start_at', '<', to)
      .where('stop_at', '>', from)
      .orderBy('channel_id')
      .orderBy('start_at')
      .execute();
    return rows.map(toProgramme);
  }

  async upcoming(queries: ProgrammeQuery[], now: Date, perChannel: number): Promise<(ProgrammeRecord & { guideId: string })[]> {
    const results: (ProgrammeRecord & { guideId: string })[] = [];
    // Index range per channel: (guide, generation, channel, start) from a day back.
    const since = new Date(now.getTime() - 24 * 3600_000);
    for (const query of queries) {
      if (query.channelIds.length === 0) continue;
      const rows = await sql<Selectable<ProgrammesTable>>`
        SELECT p.* FROM unnest(${query.channelIds}::text[]) AS c (id)
        CROSS JOIN LATERAL (
          SELECT * FROM programmes p
          WHERE p.guide_id = ${query.guideId}::uuid AND p.generation = ${query.generation} AND p.channel_id = c.id
            AND p.start_at >= ${since} AND p.stop_at > ${now}
          ORDER BY p.start_at
          LIMIT ${perChannel}
        ) p`.execute(this.db);
      for (const row of rows.rows) results.push(toProgramme(row));
    }
    return results;
  }

  async search(refs: GuideRef[], terms: string[], from: Date, to: Date, limit: number, order: 'asc' | 'desc' = 'asc'): Promise<(ProgrammeRecord & { guideId: string })[]> {
    if (refs.length === 0 || terms.length === 0) return [];
    let query = this.db
      .selectFrom('programmes')
      .selectAll()
      .where((eb) => eb.or(refs.map((ref) => eb.and([eb('guide_id', '=', ref.guideId), eb('generation', '=', ref.generation)]))))
      .where('start_at', '<', to)
      .where('stop_at', '>', from);
    for (const term of terms) query = query.where('search', 'like', likeTerm(term));
    return (await query.orderBy('start_at', order).limit(limit).execute()).map(toProgramme);
  }

  async countChannelsWithProgrammes(query: ProgrammeQuery, from: Date, to: Date): Promise<number> {
    if (query.channelIds.length === 0) return 0;
    const row = await this.db
      .selectFrom('programmes')
      .select((eb) => eb.fn.count<string>('channel_id').distinct().as('count'))
      .where('guide_id', '=', query.guideId)
      .where('generation', '=', query.generation)
      .where(sql<boolean>`channel_id = ANY(${query.channelIds}::text[])`)
      .where('start_at', '<', to)
      .where('stop_at', '>', from)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async deleteEndedBefore(cutoff: Date): Promise<number> {
    const result = await this.db.deleteFrom('programmes').where('stop_at', '<', cutoff).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

// ---------------------------------------------------------------------------------------------
// manual mappings
// ---------------------------------------------------------------------------------------------

export class PgEpgMappingRepository implements EpgMappingRepository {
  constructor(private readonly db: Db) {}

  async listForSource(ownerId: string, sourceId: string): Promise<EpgMappingRecord[]> {
    const rows = await this.db
      .selectFrom('epg_mappings')
      .select(['channel_key', 'guide_id', 'epg_channel_id'])
      .where('owner_id', '=', ownerId)
      .where('source_id', '=', sourceId)
      .execute();
    return rows.map((row) => ({ channelKey: row.channel_key, guideId: row.guide_id, epgChannelId: row.epg_channel_id }));
  }

  async set(ownerId: string, sourceId: string, mapping: EpgMappingRecord): Promise<void> {
    await this.db
      .insertInto('epg_mappings')
      .values({ owner_id: ownerId, source_id: sourceId, channel_key: mapping.channelKey, guide_id: mapping.guideId, epg_channel_id: mapping.epgChannelId })
      .onConflict((oc) => oc.columns(['owner_id', 'source_id', 'channel_key']).doUpdateSet({ guide_id: mapping.guideId, epg_channel_id: mapping.epgChannelId, updated_at: new Date() }))
      .execute();
  }

  async remove(ownerId: string, sourceId: string, channelKey: string): Promise<boolean> {
    const result = await this.db.deleteFrom('epg_mappings').where('owner_id', '=', ownerId).where('source_id', '=', sourceId).where('channel_key', '=', channelKey).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async deleteForSource(ownerId: string, sourceId: string): Promise<void> {
    await this.db.deleteFrom('epg_mappings').where('owner_id', '=', ownerId).where('source_id', '=', sourceId).execute();
  }

  async deleteForGuide(guideId: string): Promise<void> {
    await this.db.deleteFrom('epg_mappings').where('guide_id', '=', guideId).execute();
  }
}
