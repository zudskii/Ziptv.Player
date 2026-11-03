import { sql, type Selectable } from 'kysely';

import type { ChannelEpgRecord, OperatorEpgRepository, OperatorGuideRecord, OperatorProgrammeRecord } from '../../../../application/ports/operator-epg.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import { normalizeForSearch } from '../../../../domain/shared/text.js';
import type { Db } from '../database.js';
import { json, type OperatorGuidesTable } from '../schema.js';

const BATCH = 1_000;

function toGuide(row: Selectable<OperatorGuidesTable>): OperatorGuideRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    urlHash: row.url_hash,
    host: row.host,
    status: row.status,
    priority: row.priority,
    generation: row.generation,
    syncIntervalHours: row.sync_interval_hours,
    sync: { status: row.sync_status, lastAttemptAt: row.sync_last_attempt_at, lastSuccessAt: row.sync_last_success_at, nextAt: row.sync_next_at, error: row.sync_error, failures: row.sync_failures },
    stats: row.stats,
    createdAt: row.created_at,
  };
}

/** Operator guides (XMLTV), their generations and the master channel ↔ guide channel mapping. */
export class PgOperatorEpgRepository implements OperatorEpgRepository {
  constructor(private readonly db: Db) {}

  newId(): string {
    return newEntityId();
  }

  async listGuides(): Promise<(OperatorGuideRecord & { mappedChannels: number })[]> {
    const rows = await this.db
      .selectFrom('operator_guides as g')
      .selectAll('g')
      .select((eb) => eb.selectFrom('channel_epg as m').select(eb.fn.countAll<string>().as('n')).whereRef('m.guide_id', '=', 'g.id').as('mapped'))
      .orderBy('g.priority')
      .orderBy('g.name')
      .execute();
    return rows.map((row) => ({ ...toGuide(row), mappedChannels: Number(row.mapped ?? 0) }));
  }

  async findGuide(id: string): Promise<OperatorGuideRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('operator_guides').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toGuide(row) : null;
  }

  async createGuide(guide: { id: string; name: string; url: string; urlHash: string; host: string; priority: number; syncIntervalHours: number; now: Date }): Promise<OperatorGuideRecord> {
    const row = await this.db
      .insertInto('operator_guides')
      .values({ id: guide.id, name: guide.name, url: guide.url, url_hash: guide.urlHash, host: guide.host, priority: guide.priority, sync_interval_hours: guide.syncIntervalHours, sync_status: 'queued', sync_next_at: guide.now, created_at: guide.now, updated_at: guide.now })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toGuide(row);
  }

  async updateGuide(id: string, patch: Partial<{ name: string; url: string; urlHash: string; host: string; status: 'active' | 'paused'; priority: number; syncIntervalHours: number }>, now: Date): Promise<OperatorGuideRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('operator_guides')
      .set({
        updated_at: now,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.urlHash !== undefined ? { url_hash: patch.urlHash } : {}),
        ...(patch.host !== undefined ? { host: patch.host } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.syncIntervalHours !== undefined ? { sync_interval_hours: patch.syncIntervalHours } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toGuide(row) : null;
  }

  async deleteGuide(id: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    const result = await this.db.deleteFrom('operator_guides').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async requestSync(id: string, now: Date): Promise<void> {
    // A run in progress may have read the old URL / mappings: it hands over to a new run when it ends.
    await this.db
      .updateTable('operator_guides')
      .set({ sync_status: sql`CASE WHEN sync_status = 'running' THEN 'running' ELSE 'queued' END`, sync_rerun: sql`sync_status = 'running'`, sync_next_at: now, updated_at: now })
      .where('id', '=', id)
      .execute();
  }

  async claimDue(now: Date, owner: string, leaseUntil: Date): Promise<OperatorGuideRecord | null> {
    const claimed = await sql<{ id: string; next_generation: number }>`
      UPDATE operator_guides SET lease_owner = ${owner}, lease_until = ${leaseUntil}, sync_status = 'running',
        sync_last_attempt_at = ${now}, updated_at = ${now}, sync_rerun = false,
        next_generation = greatest(next_generation, generation) + 1
      WHERE id = (
        SELECT id FROM operator_guides
        WHERE status = 'active' AND (lease_until IS NULL OR lease_until < ${now})
          AND (sync_status IN ('queued', 'running') OR sync_next_at <= ${now})
        ORDER BY sync_next_at NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, next_generation`.execute(this.db);
    const row = claimed.rows[0];
    if (!row) return null;
    const guide = await this.findGuide(row.id);
    return guide ? { ...guide, claimedGeneration: row.next_generation } : null;
  }

  async heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.db.updateTable('operator_guides').set({ lease_until: leaseUntil }).where('id', '=', id).where('lease_owner', '=', owner).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async insertChannels(guideId: string, generation: number, channels: { id: string; names: string[]; icon: string | null }[]): Promise<void> {
    for (let i = 0; i < channels.length; i += BATCH) {
      const batch = channels.slice(i, i + BATCH);
      await this.db
        .insertInto('operator_guide_channels')
        .values(batch.map((channel) => ({ guide_id: guideId, generation, id: channel.id, names: channel.names, icon: channel.icon })))
        .onConflict((oc) => oc.columns(['guide_id', 'generation', 'id']).doNothing())
        .execute();
    }
  }

  async insertProgrammes(guideId: string, generation: number, programmes: OperatorProgrammeRecord[]): Promise<void> {
    for (let i = 0; i < programmes.length; i += BATCH) {
      const batch = programmes.slice(i, i + BATCH);
      await this.db
        .insertInto('operator_programmes')
        .values(batch.map((p) => ({ guide_id: guideId, generation, epg_channel_id: p.epgChannelId, start_at: p.start, stop_at: p.stop, title: p.title, subtitle: p.subtitle, description: p.description, categories: p.categories, icon: p.icon })))
        .execute();
    }
  }

  async deleteGeneration(guideId: string, generation: number): Promise<void> {
    await this.db.deleteFrom('operator_programmes').where('guide_id', '=', guideId).where('generation', '=', generation).execute();
    await this.db.deleteFrom('operator_guide_channels').where('guide_id', '=', guideId).where('generation', '=', generation).execute();
  }

  async commitGeneration(guideId: string, owner: string, generation: number, stats: OperatorGuideRecord['stats']): Promise<boolean> {
    const result = await this.db
      .updateTable('operator_guides')
      .set({ generation, stats: json(stats) })
      .where('id', '=', guideId)
      .where('lease_owner', '=', owner)
      .where('generation', '<', generation)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    await this.db.deleteFrom('operator_programmes').where('guide_id', '=', guideId).where('generation', '<>', generation).execute();
    await this.db.deleteFrom('operator_guide_channels').where('guide_id', '=', guideId).where('generation', '<>', generation).execute();
    return true;
  }

  async completeSync(guideId: string, owner: string, result: { status: 'idle' | 'failed'; error: string | null; lastSuccessAt?: Date; nextAt: Date; failures: number }): Promise<void> {
    await this.db
      .updateTable('operator_guides')
      .set({
        sync_status: sql`CASE WHEN sync_rerun THEN 'queued' ELSE ${result.status} END`,
        sync_error: result.error,
        sync_next_at: sql`CASE WHEN sync_rerun THEN now() ELSE ${result.nextAt}::timestamptz END`,
        sync_rerun: false,
        sync_failures: result.failures,
        lease_owner: null,
        lease_until: null,
        ...(result.lastSuccessAt ? { sync_last_success_at: result.lastSuccessAt } : {}),
      })
      .where('id', '=', guideId)
      .where('lease_owner', '=', owner)
      .execute();
  }

  async channelAliases(): Promise<{ channelId: string; kind: 'name' | 'tvg_id' | 'manual'; key: string }[]> {
    const rows = await this.db
      .selectFrom('channel_aliases as a')
      .innerJoin('channel_master as c', 'c.id', 'a.channel_id')
      .select(['a.channel_id', 'a.kind', 'a.key'])
      .where('c.status', '=', 'active')
      .execute();
    return rows.map((row) => ({ channelId: row.channel_id, kind: row.kind, key: row.key }));
  }

  async activeChannels(): Promise<{ id: string; name: string }[]> {
    return this.db.selectFrom('channel_master').select(['id', 'name']).where('status', '=', 'active').orderBy('name').execute();
  }

  async currentGuideChannels(): Promise<{ guideId: string; priority: number; id: string; names: string[] }[]> {
    const rows = await this.db
      .selectFrom('operator_guide_channels as gc')
      .innerJoin('operator_guides as g', (join) => join.onRef('g.id', '=', 'gc.guide_id').onRef('g.generation', '=', 'gc.generation'))
      .select(['gc.guide_id', 'g.priority', 'gc.id', 'gc.names'])
      .where('g.status', '=', 'active')
      .execute();
    return rows.map((row) => ({ guideId: row.guide_id, priority: row.priority, id: row.id, names: row.names }));
  }

  async searchGuideChannels(query: { guideId?: string | undefined; text: string; limit: number }): Promise<{ guideId: string; id: string; names: string[]; icon: string | null }[]> {
    const term = normalizeForSearch(query.text).trim();
    let q = this.db
      .selectFrom('operator_guide_channels as gc')
      .innerJoin('operator_guides as g', (join) => join.onRef('g.id', '=', 'gc.guide_id').onRef('g.generation', '=', 'gc.generation'))
      .select(['gc.guide_id', 'gc.id', 'gc.names', 'gc.icon'])
      .orderBy('gc.id')
      .limit(query.limit);
    if (query.guideId) {
      if (!isEntityId(query.guideId)) return [];
      q = q.where('gc.guide_id', '=', query.guideId);
    }
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or([eb(sql`lower(gc.id)`, 'like', like), eb(sql`lower(array_to_string(gc.names, ' '))`, 'like', like)]));
    }
    return (await q.execute()).map((row) => ({ guideId: row.guide_id, id: row.id, names: row.names, icon: row.icon }));
  }

  async guideChannelExists(guideId: string, epgChannelId: string): Promise<boolean> {
    if (!isEntityId(guideId)) return false;
    const row = await this.db
      .selectFrom('operator_guide_channels as gc')
      .innerJoin('operator_guides as g', (join) => join.onRef('g.id', '=', 'gc.guide_id').onRef('g.generation', '=', 'gc.generation'))
      .select('gc.id')
      .where('gc.guide_id', '=', guideId)
      .where('gc.id', '=', epgChannelId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async mappings(): Promise<ChannelEpgRecord[]> {
    const rows = await this.db.selectFrom('channel_epg').selectAll().execute();
    return rows.map((row) => ({ channelId: row.channel_id, guideId: row.guide_id, epgChannelId: row.epg_channel_id, method: row.method }));
  }

  async setMapping(mapping: ChannelEpgRecord, now: Date): Promise<void> {
    await this.db
      .insertInto('channel_epg')
      .values({ channel_id: mapping.channelId, guide_id: mapping.guideId, epg_channel_id: mapping.epgChannelId, method: mapping.method, updated_at: now })
      .onConflict((oc) => oc.column('channel_id').doUpdateSet({ guide_id: mapping.guideId, epg_channel_id: mapping.epgChannelId, method: mapping.method, updated_at: now }))
      .execute();
  }

  async replaceAutoMappings(mappings: ChannelEpgRecord[], now: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('channel_epg').where('method', '=', 'auto').execute();
      for (let i = 0; i < mappings.length; i += BATCH) {
        const batch = mappings.slice(i, i + BATCH);
        if (batch.length === 0) continue;
        await trx
          .insertInto('channel_epg')
          .values(batch.map((m) => ({ channel_id: m.channelId, guide_id: m.guideId, epg_channel_id: m.epgChannelId, method: 'auto' as const, updated_at: now })))
          // A manual mapping set meanwhile wins.
          .onConflict((oc) => oc.column('channel_id').doNothing())
          .execute();
      }
    });
  }

  async deleteMapping(channelId: string): Promise<void> {
    if (!isEntityId(channelId)) return;
    await this.db.deleteFrom('channel_epg').where('channel_id', '=', channelId).execute();
  }

  async programmesFor(channelIds: string[], from: Date, to: Date): Promise<(OperatorProgrammeRecord & { channelId: string })[]> {
    const valid = channelIds.filter(isEntityId);
    if (valid.length === 0) return [];
    const rows = await sql<{ channel_id: string; epg_channel_id: string; start_at: Date; stop_at: Date; title: string; subtitle: string | null; description: string | null; categories: string[]; icon: string | null }>`
      SELECT m.channel_id, p.epg_channel_id, p.start_at, p.stop_at, p.title, p.subtitle, p.description, p.categories, p.icon
      FROM channel_epg m
      JOIN operator_guides g ON g.id = m.guide_id
      JOIN operator_programmes p ON p.guide_id = g.id AND p.generation = g.generation AND p.epg_channel_id = m.epg_channel_id
      WHERE m.channel_id IN (${sql.join(valid)}) AND p.stop_at > ${from} AND p.start_at < ${to}
      ORDER BY m.channel_id, p.start_at`.execute(this.db);
    return rows.rows.map((row) => ({ channelId: row.channel_id, epgChannelId: row.epg_channel_id, start: row.start_at, stop: row.stop_at, title: row.title, subtitle: row.subtitle, description: row.description, categories: row.categories, icon: row.icon }));
  }

  async scheduleEnds(): Promise<Map<string, Date>> {
    const rows = await sql<{ channel_id: string; ends: Date }>`
      SELECT m.channel_id, max(p.stop_at) AS ends
      FROM channel_epg m
      JOIN operator_guides g ON g.id = m.guide_id
      JOIN operator_programmes p ON p.guide_id = g.id AND p.generation = g.generation AND p.epg_channel_id = m.epg_channel_id
      GROUP BY m.channel_id`.execute(this.db);
    return new Map(rows.rows.map((row) => [row.channel_id, row.ends]));
  }
}
