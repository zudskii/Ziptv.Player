import { sql, type ExpressionBuilder, type Selectable, type Updateable } from 'kysely';

import type {
  NewSource,
  RevisionSnapshot,
  SourceAccount,
  SourceHealth,
  SourceRecord,
  SourceRepository,
  SourceSettingsPatch,
  SyncOutcome,
} from '../../../../application/ports/source-repository.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import type { SyncStage } from '../../../../domain/sources/source.js';
import type { Db } from '../database.js';
import { json, jsonOrNull, type Database, type SourcesTable, type StoredAccount, type StoredHealth } from '../schema.js';

type SourceRow = Selectable<SourcesTable>;

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    type: row.type,
    origin: row.origin,
    credential: row.credential,
    revision: row.revision,
    epgVersion: row.epg_version,
    stats: row.stats,
    sync: {
      status: row.sync_status,
      stage: row.sync_stage,
      autoSync: row.sync_auto,
      intervalHours: row.sync_interval_hours,
      lastAttemptAt: row.sync_last_attempt_at,
      lastSuccessAt: row.sync_last_success_at,
      nextSyncAt: row.sync_next_at,
      error: row.sync_error,
      consecutiveFailures: row.sync_failures,
      rerunRequested: row.sync_rerun,
    },
    health: { ...row.health, checkedAt: row.health.checkedAt ? new Date(row.health.checkedAt) : null },
    account: row.account ? fromStoredAccount(row.account) : null,
    epgUrls: row.epg_urls,
    warnings: row.warnings,
    warningCount: row.warning_count,
    format: row.format,
    encoding: row.encoding,
    xtreamCandidate: row.xtream_candidate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromStoredAccount(account: StoredAccount): SourceAccount {
  return { ...account, expiresAt: account.expiresAt ? new Date(account.expiresAt) : null };
}

function toStoredAccount(account: SourceAccount): StoredAccount {
  return { ...account, expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null };
}

function toStoredHealth(health: SourceHealth): StoredHealth {
  return { ...health, checkedAt: health.checkedAt ? health.checkedAt.toISOString() : null };
}

/** A lease that was never taken or has expired (the instance holding it is presumed dead). */
const leaseFree = (now: Date) => (eb: ExpressionBuilder<Database, 'sources'>) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', now)]);

export class PgSourceRepository implements SourceRepository {
  constructor(private readonly db: Db) {}

  newId(): string {
    return newEntityId();
  }

  isValidId(id: string): boolean {
    return isEntityId(id);
  }

  async countByOwner(ownerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('sources')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async listByOwner(ownerId: string): Promise<SourceRecord[]> {
    const rows = await this.db.selectFrom('sources').selectAll().where('owner_id', '=', ownerId).orderBy('created_at').execute();
    return rows.map(toRecord);
  }

  async findOwned(id: string, ownerId: string): Promise<SourceRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('sources').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<SourceRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('sources').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async create(source: NewSource): Promise<SourceRecord> {
    const row = await this.db
      .insertInto('sources')
      .values({
        id: source.id,
        owner_id: source.ownerId,
        name: source.name,
        type: source.type,
        origin: json(source.origin),
        credential: source.credential,
        sync_status: source.sync.status,
        sync_stage: source.sync.stage,
        sync_auto: source.sync.autoSync,
        sync_interval_hours: source.sync.intervalHours,
        sync_last_attempt_at: source.sync.lastAttemptAt,
        sync_last_success_at: source.sync.lastSuccessAt,
        sync_next_at: source.sync.nextSyncAt,
        sync_error: jsonOrNull(source.sync.error),
        sync_failures: source.sync.consecutiveFailures,
        sync_rerun: source.sync.rerunRequested,
        lease_owner: null,
        lease_until: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async updateSettings(id: string, ownerId: string, patch: SourceSettingsPatch): Promise<SourceRecord | null> {
    const set: Updateable<SourcesTable> = {
      updated_at: new Date(),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.autoSync !== undefined ? { sync_auto: patch.autoSync } : {}),
      ...(patch.intervalHours !== undefined ? { sync_interval_hours: patch.intervalHours } : {}),
      ...(patch.nextSyncAt !== undefined ? { sync_next_at: patch.nextSyncAt } : {}),
      ...(patch.credential !== undefined ? { credential: patch.credential } : {}),
      ...(patch.origin !== undefined ? { origin: json(patch.origin) } : {}),
    };
    const row = await this.db.updateTable('sources').set(set).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    const result = await this.db.deleteFrom('sources').where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async listAllIds(): Promise<{ id: string; ownerId: string }[]> {
    const rows = await this.db.selectFrom('sources').select(['id', 'owner_id']).execute();
    return rows.map((row) => ({ id: row.id, ownerId: row.owner_id }));
  }

  // --- background sync (leases) -------------------------------------------------------------

  async requestSync(id: string, now: Date): Promise<SourceRecord | null> {
    // Not running (or a dead lease): queue it.
    const queued = await this.db
      .updateTable('sources')
      .set({ sync_status: 'queued', sync_next_at: now, sync_rerun: false })
      .where('id', '=', id)
      .where(leaseFree(now))
      .returningAll()
      .executeTakeFirst();
    if (queued) return toRecord(queued);
    // Running right now: run again as soon as it finishes (it may already have read old data).
    const flagged = await this.db.updateTable('sources').set({ sync_rerun: true }).where('id', '=', id).returningAll().executeTakeFirst();
    return flagged ? toRecord(flagged) : null;
  }

  async claimDue(now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null> {
    // Queue pattern: pick one candidate row-locked with SKIP LOCKED, so concurrent instances
    // never block on (or double-claim) the same source.
    const row = await this.db
      .updateTable('sources')
      .set(claimed(now, owner, leaseUntil))
      .where('id', '=', (eb) =>
        eb
          .selectFrom('sources')
          .select('id')
          .where('type', '<>', 'm3u_file')
          .where(leaseFree(now))
          .where((cond) =>
            cond.or([cond('sync_status', 'in', ['queued', 'running']), cond.and([cond('sync_auto', '=', true), cond('sync_next_at', '<=', now)])]),
          )
          .orderBy('sync_next_at', (order) => order.asc().nullsFirst())
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async claim(id: string, now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null> {
    const row = await this.db.updateTable('sources').set(claimed(now, owner, leaseUntil)).where('id', '=', id).where(leaseFree(now)).returningAll().executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await this.db.updateTable('sources').set({ lease_until: leaseUntil }).where('id', '=', id).where('lease_owner', '=', owner).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setStage(id: string, owner: string, stage: SyncStage): Promise<void> {
    await this.db.updateTable('sources').set({ sync_stage: stage }).where('id', '=', id).where('lease_owner', '=', owner).execute();
  }

  async commitRevision(id: string, owner: string, expectedRevision: number, snapshot: RevisionSnapshot): Promise<SourceRecord | null> {
    const row = await this.db
      .updateTable('sources')
      .set({
        updated_at: sql<Date>`now()`,
        revision: snapshot.revision,
        stats: json(snapshot.stats),
        epg_urls: snapshot.epgUrls,
        warnings: json(snapshot.warnings),
        warning_count: snapshot.warningCount,
        format: snapshot.format,
        encoding: snapshot.encoding,
        xtream_candidate: snapshot.xtreamCandidate,
        ...(snapshot.account ? { account: json(toStoredAccount(snapshot.account)) } : {}),
      })
      .where('id', '=', id)
      .where('revision', '=', expectedRevision)
      .where('lease_owner', '=', owner)
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async completeSync(id: string, owner: string, outcome: SyncOutcome): Promise<SourceRecord | null> {
    // One statement: release the lease with the outcome, and — when "Sync now" was pressed
    // while this sync ran — go straight back to the queue.
    const row = await this.db
      .updateTable('sources')
      .set({
        updated_at: sql<Date>`now()`,
        sync_status: sql`CASE WHEN sync_rerun THEN 'queued' ELSE ${outcome.status}::text END`,
        sync_next_at: sql`CASE WHEN sync_rerun THEN now() ELSE ${outcome.nextSyncAt}::timestamptz END`,
        sync_rerun: false,
        sync_stage: null,
        sync_error: jsonOrNull(outcome.error),
        sync_failures: outcome.consecutiveFailures,
        lease_owner: null,
        lease_until: null,
        ...(outcome.lastSuccessAt ? { sync_last_success_at: outcome.lastSuccessAt } : {}),
        ...(outcome.account ? { account: json(toStoredAccount(outcome.account)) } : {}),
      })
      .where('id', '=', id)
      .where('lease_owner', '=', owner)
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  // --- derived state ------------------------------------------------------------------------

  async setEpgState(id: string, revision: number, epgMapped: number, linksChanged: boolean): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({
        stats: sql`jsonb_set(stats, '{epgMapped}', to_jsonb(${epgMapped}::integer))`,
        ...(linksChanged ? { epg_version: sql`epg_version + 1` } : {}),
      })
      .where('id', '=', id)
      .where('revision', '=', revision)
      .execute();
  }

  async updateHealth(id: string, health: SourceHealth): Promise<void> {
    await this.db.updateTable('sources').set({ health: json(toStoredHealth(health)) }).where('id', '=', id).execute();
  }

  async updateAccount(id: string, account: SourceAccount): Promise<void> {
    await this.db.updateTable('sources').set({ account: json(toStoredAccount(account)) }).where('id', '=', id).execute();
  }
}

function claimed(now: Date, owner: string, leaseUntil: Date): Updateable<SourcesTable> {
  return { lease_owner: owner, lease_until: leaseUntil, sync_status: 'running', sync_stage: 'connecting', sync_last_attempt_at: now, sync_rerun: false };
}
