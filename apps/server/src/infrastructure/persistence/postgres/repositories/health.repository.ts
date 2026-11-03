import { sql, type Kysely, type Selectable } from 'kysely';

import {
  alertTopic,
  type AlertChannel,
  type ChannelFeedHealth,
  type FailoverEventRecord,
  type FailoverRecord,
  type FeedHealthRecord,
  type HealthRepository,
  type IncidentKind,
  type IncidentRecord,
  type IncidentStatus,
  type ProbeResultRecord,
  type ProbeTarget,
  type RegionStateRecord,
  type SourceHealthRepository,
  type TelemetryStats,
  type TelemetrySubject,
} from '../../../../application/ports/health.js';
import { FEED_HEALTH_STATES, type FeedHealthState, type ProbeOutcome, type RegionHealth } from '../../../../domain/health/feed-health.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import { json, type Database } from '../schema.js';
import { PgOutboxRepository } from './admin.repository.js';

/** A feed that can be played (and is therefore worth probing). */
const PLAYABLE = sql`f.status = 'active' AND p.status = 'active' AND s.status = 'matched'`;
const PRUNE_BATCH = 10_000;
const PRUNE_MAX_BATCHES = 50;

type IncidentRow = Selectable<Database['incidents']>;

function toIncident(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    title: row.title,
    details: row.details,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

function toRegion(row: Selectable<Database['feed_probe_state']>): RegionStateRecord {
  return {
    region: row.region,
    state: row.state,
    failures: row.failures,
    successes: row.successes,
    lastProbeAt: row.last_probe_at,
    lastOkAt: row.last_ok_at,
    lastOutcome: row.last_outcome,
    lastError: row.last_error,
  };
}

function toFailover(row: Selectable<Database['channel_failover']>): FailoverRecord {
  return {
    channelId: row.channel_id,
    activeFeedId: row.active_feed_id,
    pinnedFeedId: row.pinned_feed_id,
    pinnedUntil: row.pinned_until,
    pinnedBy: row.pinned_by,
    pinNote: row.pin_note,
    lastSwitchAt: row.last_switch_at,
  };
}

/**
 * Health state in PostgreSQL. Bound to the pool or (inside `transaction`) to one transaction,
 * so overall-state and failover decisions lock exactly the rows they decide on.
 */
export class PgHealthRepository implements HealthRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly inTransaction = false,
  ) {}

  transaction<T>(work: (tx: HealthRepository) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this);
    return this.db.transaction().execute((trx) => work(new PgHealthRepository(trx, true)));
  }

  // --- probe scheduling ---------------------------------------------------------------------------

  async ensureProbeRows(region: string, now: Date): Promise<number> {
    // New feeds are spread over the first 30 s so a big import does not probe in one burst.
    const inserted = await sql`
      INSERT INTO feed_probe_state (feed_id, region, next_probe_at)
      SELECT f.id, ${region}, ${now}::timestamptz + random() * interval '30 seconds'
      FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      WHERE ${PLAYABLE}
      ON CONFLICT DO NOTHING`.execute(this.db);
    await sql`
      INSERT INTO feed_health (feed_id)
      SELECT f.id FROM channel_feeds f
      ON CONFLICT DO NOTHING`.execute(this.db);
    return Number(inserted.numAffectedRows ?? 0n);
  }

  async claimDueProbe(region: string, now: Date, owner: string, leaseUntil: Date, providerLimit: number): Promise<ProbeTarget | null> {
    const run = async (db: Kysely<Database>) => {
      // Claims are serialised (cheap, short) so the per-provider limit cannot be overshot by two
      // instances claiming at once. The limit spans regions: an account's connection limit is
      // global, wherever the probes come from.
      await sql`SELECT pg_advisory_xact_lock(hashtext('ziptv:probe-claim'))`.execute(db);
      // A scalar subquery (evaluated once, as an InitPlan): an `UPDATE … FROM (SELECT … LIMIT 1 FOR
      // UPDATE SKIP LOCKED)` join can be re-scanned per row and lease several rows at once.
      const claimed = await sql<{ feed_id: string }>`
        UPDATE feed_probe_state ps SET lease_owner = ${owner}, lease_until = ${leaseUntil}
        WHERE ps.region = ${region} AND ps.feed_id = (
          SELECT c.feed_id FROM feed_probe_state c
          JOIN channel_feeds f ON f.id = c.feed_id
          JOIN providers p ON p.id = f.provider_id
          JOIN provider_streams s ON s.id = f.provider_stream_id
          WHERE c.region = ${region}
            AND c.next_probe_at <= ${now}
            AND (c.lease_until IS NULL OR c.lease_until < ${now})
            AND ${PLAYABLE}
            AND (
              SELECT count(*) FROM feed_probe_state x JOIN channel_feeds fx ON fx.id = x.feed_id
              WHERE fx.provider_id = f.provider_id AND x.lease_until >= ${now}
            ) < ${providerLimit}
          ORDER BY c.next_probe_at
          LIMIT 1
          FOR UPDATE OF c SKIP LOCKED
        )
        RETURNING ps.feed_id`.execute(db);
      return claimed.rows[0]?.feed_id ?? null;
    };
    const feedId = this.inTransaction ? await run(this.db) : await this.db.transaction().execute(run);
    if (!feedId) return null;
    const row = await this.db
      .selectFrom('feed_probe_state as ps')
      .innerJoin('channel_feeds as f', 'f.id', 'ps.feed_id')
      .selectAll('ps')
      .select(['f.channel_id', 'f.provider_id', 'f.provider_stream_id'])
      .where('ps.feed_id', '=', feedId)
      .where('ps.region', '=', region)
      .executeTakeFirstOrThrow();
    return {
      feedId,
      region,
      channelId: row.channel_id,
      providerId: row.provider_id,
      streamId: row.provider_stream_id,
      health: { state: row.state, failures: row.failures, successes: row.successes },
      previous: row.media_sequence !== null && row.sequence_at ? { mediaSequence: Number(row.media_sequence), lastSegment: row.last_segment, at: row.sequence_at } : null,
      lastDecodeAt: row.last_decode_at,
    };
  }

  async heartbeatProbe(feedId: string, region: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('feed_probe_state')
      .set({ lease_until: leaseUntil })
      .where('feed_id', '=', feedId)
      .where('region', '=', region)
      .where('lease_owner', '=', owner)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async completeProbe(
    target: { feedId: string; region: string },
    owner: string,
    update: {
      health: RegionHealth;
      outcome: ProbeOutcome;
      error: string | null;
      probedAt: Date;
      ok: boolean;
      nextProbeAt: Date;
      playlist: { mediaSequence: number; lastSegment: string | null } | null;
      keepSequenceAt: boolean;
      decoded: boolean;
    },
    results: ProbeResultRecord[],
  ): Promise<boolean> {
    const window = update.playlist
      ? update.keepSequenceAt
        ? {}
        : { media_sequence: String(update.playlist.mediaSequence), last_segment: update.playlist.lastSegment, sequence_at: update.probedAt }
      : { media_sequence: null, last_segment: null, sequence_at: null };
    const updated = await this.db
      .updateTable('feed_probe_state')
      .set({
        state: update.health.state,
        failures: update.health.failures,
        successes: update.health.successes,
        last_outcome: update.outcome,
        last_error: update.error,
        last_probe_at: update.probedAt,
        ...(update.ok ? { last_ok_at: update.probedAt } : {}),
        ...(update.decoded ? { last_decode_at: update.probedAt } : {}),
        next_probe_at: update.nextProbeAt,
        lease_owner: null,
        lease_until: null,
        ...window,
      })
      .where('feed_id', '=', target.feedId)
      .where('region', '=', target.region)
      .where('lease_owner', '=', owner)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return false;
    if (results.length > 0) {
      await this.db
        .insertInto('stream_probe_results')
        .values(
          results.map((result) => ({
            feed_id: result.feedId,
            region: result.region,
            probed_at: result.probedAt,
            kind: result.kind,
            outcome: result.outcome,
            http_status: result.httpStatus,
            ttfb_ms: result.ttfbMs,
            duration_ms: result.durationMs,
            bytes: result.bytes,
            media_sequence: result.mediaSequence === null ? null : String(result.mediaSequence),
            error: result.error?.slice(0, 500) ?? null,
          })),
        )
        .execute();
    }
    return true;
  }

  async requestProbe(feedId: string, now: Date): Promise<void> {
    await this.db.updateTable('feed_probe_state').set({ next_probe_at: now }).where('feed_id', '=', feedId).where('next_probe_at', '>', now).execute();
  }

  async postponeProbe(target: { feedId: string; region: string }, owner: string, nextProbeAt: Date): Promise<void> {
    await this.db
      .updateTable('feed_probe_state')
      .set({ next_probe_at: nextProbeAt, lease_owner: null, lease_until: null })
      .where('feed_id', '=', target.feedId)
      .where('region', '=', target.region)
      .where('lease_owner', '=', owner)
      .execute();
  }

  // --- feed health ---------------------------------------------------------------------------------

  async regionStates(feedId: string): Promise<RegionStateRecord[]> {
    const rows = await this.db.selectFrom('feed_probe_state').selectAll().where('feed_id', '=', feedId).orderBy('region').execute();
    return rows.map(toRegion);
  }

  async lockFeedHealth(feedId: string): Promise<{ status: FeedHealthState; since: Date; maintenance: boolean }> {
    await this.db.insertInto('feed_health').values({ feed_id: feedId }).onConflict((conflict) => conflict.column('feed_id').doNothing()).execute();
    const row = await this.db.selectFrom('feed_health').select(['status', 'since', 'maintenance']).where('feed_id', '=', feedId).forUpdate().executeTakeFirstOrThrow();
    return row;
  }

  async setFeedStatus(feedId: string, status: FeedHealthState, now: Date): Promise<void> {
    await this.db.updateTable('feed_health').set({ status, since: now, updated_at: now }).where('feed_id', '=', feedId).where('status', '<>', status).execute();
  }

  async setMaintenance(feedId: string, maintenance: boolean, note: string | null, now: Date): Promise<void> {
    await this.db.insertInto('feed_health').values({ feed_id: feedId }).onConflict((conflict) => conflict.column('feed_id').doNothing()).execute();
    await this.db.updateTable('feed_health').set({ maintenance, maintenance_note: maintenance ? note : null, updated_at: now }).where('feed_id', '=', feedId).execute();
  }

  async providerFeedStatuses(providerId: string): Promise<{ feedId: string; status: FeedHealthState }[]> {
    const rows = await sql<{ id: string; status: FeedHealthState }>`
      SELECT f.id, coalesce(h.status, 'UNKNOWN') AS status
      FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      LEFT JOIN feed_health h ON h.feed_id = f.id
      WHERE f.provider_id = ${providerId} AND ${PLAYABLE}`.execute(this.db);
    return rows.rows.map((row) => ({ feedId: row.id, status: row.status }));
  }

  async feedHealthList(query: { status?: FeedHealthState | undefined; channelId?: string | undefined; providerId?: string | undefined; offset: number; limit: number }): Promise<{ items: FeedHealthRecord[]; total: number }> {
    let base = this.db
      .selectFrom('channel_feeds as f')
      .innerJoin('channel_master as c', 'c.id', 'f.channel_id')
      .innerJoin('providers as p', 'p.id', 'f.provider_id')
      .leftJoin('feed_health as h', 'h.feed_id', 'f.id');
    if (query.status) base = query.status === 'UNKNOWN' ? base.where((eb) => eb.or([eb('h.status', '=', 'UNKNOWN'), eb('h.status', 'is', null)])) : base.where('h.status', '=', query.status);
    if (query.channelId) base = base.where('f.channel_id', '=', query.channelId);
    if (query.providerId) base = base.where('f.provider_id', '=', query.providerId);
    const [rows, count] = await Promise.all([
      base
        .select(['f.id', 'f.channel_id', 'c.name as channel_name', 'f.provider_id', 'p.name as provider_name', 'f.priority', 'f.status as feed_status', 'h.status', 'h.since', 'h.maintenance', 'h.maintenance_note', 'f.created_at'])
        .orderBy('c.name')
        .orderBy('f.priority')
        .offset(query.offset)
        .limit(query.limit)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
    ]);
    const regions = rows.length ? await this.db.selectFrom('feed_probe_state').selectAll().where('feed_id', 'in', rows.map((row) => row.id)).orderBy('region').execute() : [];
    return {
      total: Number(count.count),
      items: rows.map((row) => ({
        feedId: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        providerId: row.provider_id,
        providerName: row.provider_name,
        priority: row.priority,
        feedStatus: row.feed_status,
        status: row.status ?? 'UNKNOWN',
        since: row.since ?? row.created_at,
        maintenance: row.maintenance ?? false,
        maintenanceNote: row.maintenance_note ?? null,
        regions: regions.filter((region) => region.feed_id === row.id).map(toRegion),
      })),
    };
  }

  async feedHealthOf(feedIds: string[]): Promise<Map<string, FeedHealthState>> {
    if (feedIds.length === 0) return new Map();
    const rows = await this.db.selectFrom('feed_health').select(['feed_id', 'status']).where('feed_id', 'in', feedIds).execute();
    return new Map(rows.map((row) => [row.feed_id, row.status]));
  }

  async probeHistory(feedId: string, limit: number): Promise<ProbeResultRecord[]> {
    const rows = await this.db.selectFrom('stream_probe_results').selectAll().where('feed_id', '=', feedId).orderBy('probed_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map((row) => ({
      feedId: row.feed_id,
      region: row.region,
      probedAt: row.probed_at,
      kind: row.kind,
      outcome: row.outcome,
      httpStatus: row.http_status,
      ttfbMs: row.ttfb_ms,
      durationMs: row.duration_ms ?? 0,
      bytes: row.bytes,
      mediaSequence: row.media_sequence === null ? null : Number(row.media_sequence),
      error: row.error,
    }));
  }

  async statusCounts(): Promise<Record<FeedHealthState, number>> {
    const rows = await sql<{ status: FeedHealthState; count: string }>`
      SELECT coalesce(h.status, 'UNKNOWN') AS status, count(*) AS count
      FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      LEFT JOIN feed_health h ON h.feed_id = f.id
      WHERE ${PLAYABLE}
      GROUP BY 1`.execute(this.db);
    const counts = Object.fromEntries(FEED_HEALTH_STATES.map((state) => [state, 0])) as Record<FeedHealthState, number>;
    for (const row of rows.rows) counts[row.status] = Number(row.count);
    return counts;
  }

  // --- failover ----------------------------------------------------------------------------------

  async channelFeeds(channelId: string): Promise<ChannelFeedHealth[]> {
    if (!isEntityId(channelId)) return [];
    const rows = await sql<{ id: string; priority: number; created_at: Date; provider_id: string; status: FeedHealthState }>`
      SELECT f.id, f.priority, f.created_at, f.provider_id, coalesce(h.status, 'UNKNOWN') AS status
      FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      LEFT JOIN feed_health h ON h.feed_id = f.id
      WHERE f.channel_id = ${channelId} AND ${PLAYABLE}
      ORDER BY f.priority, f.created_at`.execute(this.db);
    return rows.rows.map((row) => ({ id: row.id, priority: row.priority, createdAt: row.created_at, providerId: row.provider_id, health: row.status }));
  }

  async lockFailover(channelId: string): Promise<FailoverRecord> {
    await this.db.insertInto('channel_failover').values({ channel_id: channelId, active_feed_id: null, pinned_feed_id: null, pinned_until: null, pinned_by: null, pin_note: null, last_switch_at: null }).onConflict((conflict) => conflict.column('channel_id').doNothing()).execute();
    return toFailover(await this.db.selectFrom('channel_failover').selectAll().where('channel_id', '=', channelId).forUpdate().executeTakeFirstOrThrow());
  }

  async saveFailover(record: FailoverRecord, now: Date): Promise<void> {
    await this.db
      .updateTable('channel_failover')
      .set({
        active_feed_id: record.activeFeedId,
        pinned_feed_id: record.pinnedFeedId,
        pinned_until: record.pinnedUntil,
        pinned_by: record.pinnedBy,
        pin_note: record.pinNote,
        last_switch_at: record.lastSwitchAt,
        updated_at: now,
      })
      .where('channel_id', '=', record.channelId)
      .execute();
  }

  async failoverOf(channelId: string): Promise<FailoverRecord | null> {
    if (!isEntityId(channelId)) return null;
    const row = await this.db.selectFrom('channel_failover').selectAll().where('channel_id', '=', channelId).executeTakeFirst();
    return row ? toFailover(row) : null;
  }

  async appendFailoverEvent(event: Omit<FailoverEventRecord, 'id'>): Promise<void> {
    await this.db
      .insertInto('failover_events')
      .values({
        channel_id: event.channelId,
        occurred_at: event.occurredAt,
        from_feed_id: event.fromFeedId,
        to_feed_id: event.toFeedId,
        reason: event.reason,
        actor_id: event.actorId,
        actor_email: event.actorEmail,
        details: json(event.details),
      })
      .execute();
  }

  async failoverEvents(channelId: string, limit: number): Promise<FailoverEventRecord[]> {
    if (!isEntityId(channelId)) return [];
    const rows = await this.db.selectFrom('failover_events').selectAll().where('channel_id', '=', channelId).orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map((row) => ({
      id: Number(row.id),
      channelId: row.channel_id,
      occurredAt: row.occurred_at,
      fromFeedId: row.from_feed_id,
      toFeedId: row.to_feed_id,
      reason: row.reason,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      details: row.details,
    }));
  }

  async channelsWithFeeds(): Promise<string[]> {
    const rows = await sql<{ channel_id: string }>`
      SELECT DISTINCT f.channel_id FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      WHERE ${PLAYABLE}
      UNION
      SELECT channel_id FROM channel_failover WHERE active_feed_id IS NOT NULL`.execute(this.db);
    return rows.rows.map((row) => row.channel_id);
  }

  // --- incidents ---------------------------------------------------------------------------------

  async openIncident(input: Omit<IncidentRecord, 'status' | 'openedAt' | 'lastSeenAt' | 'acknowledgedAt' | 'acknowledgedBy' | 'resolvedAt' | 'resolvedBy'>, now: Date): Promise<{ incident: IncidentRecord; created: boolean }> {
    const result = await sql<IncidentRow & { created: boolean }>`
      INSERT INTO incidents (id, kind, severity, status, target_type, target_id, title, details, opened_at, last_seen_at)
      VALUES (${input.id}, ${input.kind}, ${input.severity}, 'open', ${input.targetType}, ${input.targetId}, ${input.title}, ${json(input.details)}::jsonb, ${now}, ${now})
      ON CONFLICT (kind, target_id) WHERE status <> 'resolved'
      DO UPDATE SET last_seen_at = excluded.last_seen_at, title = excluded.title, details = excluded.details, severity = excluded.severity
      RETURNING *, (xmax = 0) AS created`.execute(this.db);
    const row = result.rows[0]!;
    return { incident: toIncident(row), created: row.created };
  }

  async resolveIncident(kind: IncidentKind, targetId: string, now: Date, by: string | null): Promise<IncidentRecord | null> {
    const row = await this.db
      .updateTable('incidents')
      .set({ status: 'resolved', resolved_at: now, resolved_by: by, last_seen_at: now })
      .where('kind', '=', kind)
      .where('target_id', '=', targetId)
      .where('status', '<>', 'resolved')
      .returningAll()
      .executeTakeFirst();
    return row ? toIncident(row) : null;
  }

  async findIncident(id: string): Promise<IncidentRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('incidents').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toIncident(row) : null;
  }

  async acknowledgeIncident(id: string, staffId: string, now: Date): Promise<IncidentRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('incidents')
      .set({ status: 'acknowledged', acknowledged_at: now, acknowledged_by: staffId })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst();
    return row ? toIncident(row) : null;
  }

  async resolveIncidentById(id: string, staffId: string, now: Date): Promise<IncidentRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('incidents')
      .set({ status: 'resolved', resolved_at: now, resolved_by: staffId })
      .where('id', '=', id)
      .where('status', '<>', 'resolved')
      .returningAll()
      .executeTakeFirst();
    return row ? toIncident(row) : null;
  }

  async listIncidents(query: { status?: IncidentStatus | 'live' | undefined; offset: number; limit: number }): Promise<{ items: IncidentRecord[]; total: number }> {
    let base = this.db.selectFrom('incidents');
    if (query.status === 'live') base = base.where('status', '<>', 'resolved');
    else if (query.status) base = base.where('status', '=', query.status);
    const [rows, count] = await Promise.all([
      base.selectAll().orderBy('opened_at', 'desc').orderBy('id').offset(query.offset).limit(query.limit).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toIncident), total: Number(count.count) };
  }

  async openIncidentCounts(): Promise<Record<IncidentKind, number>> {
    const rows = await this.db.selectFrom('incidents').select(['kind', (eb) => eb.fn.countAll<string>().as('count')]).where('status', '<>', 'resolved').groupBy('kind').execute();
    const counts: Record<IncidentKind, number> = { feed_unhealthy: 0, channel_down: 0, provider_outage: 0 };
    for (const row of rows) counts[row.kind] = Number(row.count);
    return counts;
  }

  async orphanIncidents(): Promise<IncidentRecord[]> {
    const rows = await sql<IncidentRow>`
      SELECT i.* FROM incidents i
      WHERE i.status <> 'resolved' AND (
        (i.target_type = 'feed' AND NOT EXISTS (
          SELECT 1 FROM channel_feeds f
          JOIN providers p ON p.id = f.provider_id
          JOIN provider_streams s ON s.id = f.provider_stream_id
          WHERE f.id = i.target_id AND ${PLAYABLE}))
        OR (i.target_type = 'provider' AND NOT EXISTS (SELECT 1 FROM providers p WHERE p.id = i.target_id AND p.status = 'active'))
        OR (i.target_type = 'channel' AND NOT EXISTS (SELECT 1 FROM channel_master c WHERE c.id = i.target_id))
      )
      LIMIT 500`.execute(this.db);
    return rows.rows.map(toIncident);
  }

  async enqueueAlert(channel: AlertChannel, payload: { incidentId: string; event: 'opened' | 'resolved' }, now: Date): Promise<void> {
    await new PgOutboxRepository(this.db).enqueue({ id: newEntityId(), topic: alertTopic(channel), payload, now });
  }

  // --- telemetry ---------------------------------------------------------------------------------

  async recordTelemetry(subject: TelemetrySubject, bucket: Date, sample: { start?: { startupMs: number | null }; error?: boolean }): Promise<void> {
    const starts = sample.start ? 1 : 0;
    const errors = sample.error ? 1 : 0;
    const startupMs = sample.start?.startupMs ?? null;
    await sql`
      INSERT INTO playback_telemetry (subject_type, subject_id, bucket, starts, errors, startup_ms_sum, startup_count)
      VALUES (${subject.type}, ${subject.id}, ${bucket}, ${starts}, ${errors}, ${startupMs ?? 0}, ${startupMs === null ? 0 : 1})
      ON CONFLICT (subject_type, subject_id, bucket) DO UPDATE SET
        starts = playback_telemetry.starts + excluded.starts,
        errors = playback_telemetry.errors + excluded.errors,
        startup_ms_sum = playback_telemetry.startup_ms_sum + excluded.startup_ms_sum,
        startup_count = playback_telemetry.startup_count + excluded.startup_count`.execute(this.db);
  }

  async telemetrySince(subject: TelemetrySubject, since: Date): Promise<TelemetryStats> {
    const row = await sql<{ starts: string | null; errors: string | null; ms: string | null; n: string | null }>`
      SELECT sum(starts) AS starts, sum(errors) AS errors, sum(startup_ms_sum) AS ms, sum(startup_count) AS n
      FROM playback_telemetry
      WHERE subject_type = ${subject.type} AND subject_id = ${subject.id} AND bucket >= ${since}`.execute(this.db);
    const stats = row.rows[0];
    const n = Number(stats?.n ?? 0);
    return { starts: Number(stats?.starts ?? 0), errors: Number(stats?.errors ?? 0), avgStartupMs: n > 0 ? Math.round(Number(stats?.ms ?? 0) / n) : null };
  }

  // --- retention ---------------------------------------------------------------------------------

  async prune(cutoffs: { probes: Date; telemetry: Date; failoverEvents: Date; incidents: Date }): Promise<{ probes: number; telemetry: number; failoverEvents: number; incidents: number }> {
    // Batched: one huge DELETE would hold locks and bloat WAL; small batches interleave with work.
    const batched = async (statement: () => Promise<{ numAffectedRows?: bigint }>) => {
      let total = 0;
      for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
        const deleted = Number((await statement()).numAffectedRows ?? 0n);
        total += deleted;
        if (deleted < PRUNE_BATCH) break;
      }
      return total;
    };
    return {
      probes: await batched(() => sql`DELETE FROM stream_probe_results WHERE id IN (SELECT id FROM stream_probe_results WHERE probed_at < ${cutoffs.probes} LIMIT ${PRUNE_BATCH})`.execute(this.db)),
      telemetry: await batched(() => sql`DELETE FROM playback_telemetry WHERE ctid IN (SELECT ctid FROM playback_telemetry WHERE bucket < ${cutoffs.telemetry} LIMIT ${PRUNE_BATCH})`.execute(this.db)),
      failoverEvents: await batched(() => sql`DELETE FROM failover_events WHERE id IN (SELECT id FROM failover_events WHERE occurred_at < ${cutoffs.failoverEvents} LIMIT ${PRUNE_BATCH})`.execute(this.db)),
      incidents: await batched(() => sql`DELETE FROM incidents WHERE id IN (SELECT id FROM incidents WHERE status = 'resolved' AND resolved_at < ${cutoffs.incidents} LIMIT ${PRUNE_BATCH})`.execute(this.db)),
    };
  }
}

export class PgSourceHealthRepository implements SourceHealthRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async ensureRows(activeSince: Date, now: Date): Promise<number> {
    // Only synced URL/Xtream sources of accounts seen recently: nobody needs a status for an
    // abandoned account, and every check is a request to someone's provider.
    const inserted = await sql`
      INSERT INTO source_probe_state (source_id, next_check_at)
      SELECT s.id, ${now}::timestamptz + random() * interval '5 minutes'
      FROM sources s JOIN users u ON u.id = s.owner_id
      WHERE s.type IN ('m3u_url', 'xtream') AND s.revision > 0 AND u.last_seen_at >= ${activeSince}
      ON CONFLICT DO NOTHING`.execute(this.db);
    return Number(inserted.numAffectedRows ?? 0n);
  }

  async claimDue(now: Date, owner: string, leaseUntil: Date): Promise<{ sourceId: string; checks: { ok: boolean; latencyMs: number | null; at: string }[] } | null> {
    const result = await sql<{ source_id: string; checks: { ok: boolean; latencyMs: number | null; at: string }[] }>`
      UPDATE source_probe_state ps SET lease_owner = ${owner}, lease_until = ${leaseUntil}
      WHERE ps.source_id = (
        SELECT c.source_id FROM source_probe_state c
        WHERE c.next_check_at <= ${now} AND (c.lease_until IS NULL OR c.lease_until < ${now})
        ORDER BY c.next_check_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING ps.source_id, ps.checks`.execute(this.db);
    const row = result.rows[0];
    return row ? { sourceId: row.source_id, checks: row.checks } : null;
  }

  async complete(sourceId: string, owner: string, checks: { ok: boolean; latencyMs: number | null; at: string }[], nextAt: Date): Promise<void> {
    await this.db
      .updateTable('source_probe_state')
      .set({ checks: json(checks.slice(0, 5)), next_check_at: nextAt, lease_owner: null, lease_until: null })
      .where('source_id', '=', sourceId)
      .where('lease_owner', '=', owner)
      .execute();
  }
}
