import { sql, type Selectable } from 'kysely';

import type {
  AdminQueries,
  AdminTransaction,
  AdminUnitOfWork,
  AdminUserRecord,
  AuditFilter,
  AuditRecord,
  AuditRepository,
  NewAuditEntry,
  OutboxMessage,
  OutboxRepository,
  StaffRecord,
  StaffRepository,
  StaffSessionRecord,
  StaffSessionRepository,
  StaffWithPassword,
} from '../../../../application/ports/admin.js';
import { AUDIT_GENESIS, auditHash } from '../../../../domain/admin/audit.js';
import type { StaffRole } from '../../../../domain/admin/rbac.js';
import { isEntityId } from '../../../../domain/shared/ids.js';
import type { Db } from '../database.js';
import { json, type AdminAuditLogsTable, type StaffSessionsTable, type StaffUsersTable } from '../schema.js';
import { PgSessionRepository } from './session.repository.js';

/** Serialises audit appends across every instance (pg_advisory_xact_lock key). */
const AUDIT_LOCK_KEY = 7_042_201;
/** Serialises staff administration (last-super-admin rule). */
const STAFF_ADMIN_LOCK_KEY = 7_042_202;

function toStaff(row: Selectable<StaffUsersTable>): StaffWithPassword {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    passwordHash: row.password_hash,
    mfaSecret: row.mfa_secret,
    mfaEnabledAt: row.mfa_enabled_at,
    mfaLastStep: row.mfa_last_step === null ? null : Number(row.mfa_last_step),
    mustChangePassword: row.must_change_password,
    mfaFailures: row.mfa_failures,
    lockedUntil: row.locked_until,
    disabledAt: row.disabled_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withoutPassword(staff: StaffWithPassword): StaffRecord {
  const { passwordHash: _passwordHash, ...rest } = staff;
  return rest;
}

export class PgStaffRepository implements StaffRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<StaffWithPassword | null> {
    const row = await this.db.selectFrom('staff_users').selectAll().where('email', '=', email).executeTakeFirst();
    return row ? toStaff(row) : null;
  }

  async findById(id: string): Promise<StaffWithPassword | null> {
    const row = await this.db.selectFrom('staff_users').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toStaff(row) : null;
  }

  async list(): Promise<StaffRecord[]> {
    const rows = await this.db.selectFrom('staff_users').selectAll().orderBy('created_at').execute();
    return rows.map((row) => withoutPassword(toStaff(row)));
  }

  async countActiveSuperAdmins(): Promise<number> {
    const row = await this.db
      .selectFrom('staff_users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('role', '=', 'SUPER_ADMIN')
      .where('disabled_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async create(staff: { id: string; email: string; name: string; role: StaffRole; passwordHash: string; now: Date }): Promise<StaffRecord> {
    const row = await this.db
      .insertInto('staff_users')
      .values({
        id: staff.id,
        email: staff.email,
        name: staff.name,
        role: staff.role,
        password_hash: staff.passwordHash,
        mfa_secret: null,
        mfa_enabled_at: null,
        mfa_last_step: null,
        must_change_password: true,
        locked_until: null,
        disabled_at: null,
        last_login_at: null,
        created_at: staff.now,
        updated_at: staff.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return withoutPassword(toStaff(row));
  }

  async update(
    id: string,
    patch: Partial<{ name: string; role: StaffRole; disabledAt: Date | null; passwordHash: string; mustChangePassword: boolean; mfaSecret: string | null; mfaEnabledAt: Date | null; mfaLastStep: number | null; lastLoginAt: Date }>,
    now: Date,
  ): Promise<StaffRecord | null> {
    const row = await this.db
      .updateTable('staff_users')
      .set({
        updated_at: now,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.disabledAt !== undefined ? { disabled_at: patch.disabledAt } : {}),
        ...(patch.passwordHash !== undefined ? { password_hash: patch.passwordHash } : {}),
        ...(patch.mustChangePassword !== undefined ? { must_change_password: patch.mustChangePassword } : {}),
        ...(patch.mfaSecret !== undefined ? { mfa_secret: patch.mfaSecret } : {}),
        ...(patch.mfaEnabledAt !== undefined ? { mfa_enabled_at: patch.mfaEnabledAt } : {}),
        ...(patch.mfaLastStep !== undefined ? { mfa_last_step: patch.mfaLastStep } : {}),
        ...(patch.lastLoginAt !== undefined ? { last_login_at: patch.lastLoginAt } : {}),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? withoutPassword(toStaff(row)) : null;
  }

  async enrollMfa(id: string, sealedSecret: string, now: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('staff_users')
      .set({ mfa_secret: sealedSecret, mfa_enabled_at: now, updated_at: now })
      .where('id', '=', id)
      .where('mfa_enabled_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async recordMfaFailure(id: string, limit: number, lockUntil: Date): Promise<boolean> {
    const row = await sql<{ locked: boolean }>`
      UPDATE staff_users SET
        mfa_failures = CASE WHEN mfa_failures + 1 >= ${limit} THEN 0 ELSE mfa_failures + 1 END,
        locked_until = CASE WHEN mfa_failures + 1 >= ${limit} THEN ${lockUntil}::timestamptz ELSE locked_until END
      WHERE id = ${id}
      RETURNING locked_until IS NOT DISTINCT FROM ${lockUntil}::timestamptz AS locked`.execute(this.db);
    return row.rows[0]?.locked ?? false;
  }

  async resetMfaFailures(id: string): Promise<void> {
    await this.db.updateTable('staff_users').set({ mfa_failures: 0, locked_until: null }).where('id', '=', id).execute();
  }

  async lockAdministration(): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${STAFF_ADMIN_LOCK_KEY})`.execute(this.db);
  }

  async claimMfaStep(id: string, step: number): Promise<boolean> {
    const result = await this.db
      .updateTable('staff_users')
      .set({ mfa_last_step: step })
      .where('id', '=', id)
      .where((eb) => eb.or([eb('mfa_last_step', 'is', null), eb('mfa_last_step', '<', String(step) as never)]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

function toSession(row: Selectable<StaffSessionsTable>): StaffSessionRecord {
  return { id: row.id, staffId: row.staff_id, createdAt: row.created_at, lastSeenAt: row.last_seen_at, idleExpiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at };
}

export class PgStaffSessionRepository implements StaffSessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: StaffSessionRecord & { tokenHash: string; ip: string | null; userAgent: string | null }): Promise<void> {
    await this.db
      .insertInto('staff_sessions')
      .values({
        id: session.id,
        staff_id: session.staffId,
        token_hash: session.tokenHash,
        ip: session.ip,
        user_agent: session.userAgent,
        created_at: session.createdAt,
        last_seen_at: session.lastSeenAt,
        idle_expires_at: session.idleExpiresAt,
        absolute_expires_at: session.absoluteExpiresAt,
      })
      .execute();
  }

  async findByTokenHash(tokenHash: string): Promise<{ session: StaffSessionRecord; staff: StaffRecord } | null> {
    const session = await this.db.selectFrom('staff_sessions').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
    if (!session) return null;
    const staff = await this.db.selectFrom('staff_users').selectAll().where('id', '=', session.staff_id).executeTakeFirst();
    if (!staff) return null;
    return { session: toSession(session), staff: withoutPassword(toStaff(staff)) };
  }

  async touch(id: string, at: Date, idleExpiresAt: Date): Promise<void> {
    await this.db.updateTable('staff_sessions').set({ last_seen_at: at, idle_expires_at: idleExpiresAt }).where('id', '=', id).execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('staff_sessions').where('id', '=', id).execute();
  }

  async deleteForStaff(staffId: string, keepSessionId?: string): Promise<number> {
    let query = this.db.deleteFrom('staff_sessions').where('staff_id', '=', staffId);
    if (keepSessionId) query = query.where('id', '!=', keepSessionId);
    return Number((await query.executeTakeFirst()).numDeletedRows);
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('staff_sessions')
      .where((eb) => eb.or([eb('idle_expires_at', '<=', now), eb('absolute_expires_at', '<=', now)]))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

function toAudit(row: Selectable<AdminAuditLogsTable>): AuditRecord {
  return {
    seq: Number(row.seq),
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    details: row.details,
    ip: row.ip,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export function auditFieldsOf(record: Omit<AuditRecord, 'hash'>) {
  return {
    seq: record.seq,
    occurredAt: record.occurredAt.toISOString(),
    actorId: record.actorId,
    actorEmail: record.actorEmail,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    details: record.details,
    ip: record.ip,
    prevHash: record.prevHash,
  };
}

export class PgAuditRepository implements AuditRepository {
  constructor(
    private readonly db: Db,
    /** Appends need the transaction's advisory lock; outside a transaction only reads are allowed. */
    private readonly inTransaction: boolean,
  ) {}

  async append(entry: NewAuditEntry): Promise<AuditRecord> {
    if (!this.inTransaction) throw new Error('Audit entries must be appended inside a unit of work');
    await sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`.execute(this.db);
    const last = await this.db.selectFrom('admin_audit_logs').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    // Millisecond precision: what Postgres stores is exactly what is hashed.
    const occurredAt = new Date(Math.floor(entry.occurredAt.getTime()));
    const base = { ...entry, occurredAt, seq: last ? Number(last.seq) + 1 : 1, prevHash: last?.hash ?? AUDIT_GENESIS };
    const hash = auditHash(auditFieldsOf(base));
    await this.db
      .insertInto('admin_audit_logs')
      .values({
        seq: base.seq,
        occurred_at: occurredAt,
        actor_id: entry.actorId,
        actor_email: entry.actorEmail,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        before_hash: entry.beforeHash,
        after_hash: entry.afterHash,
        details: json(entry.details),
        ip: entry.ip,
        prev_hash: base.prevHash,
        hash,
      })
      .execute();
    return { ...base, hash };
  }

  async list(filter: AuditFilter): Promise<AuditRecord[]> {
    let query = this.db.selectFrom('admin_audit_logs').selectAll();
    if (filter.actorId) query = query.where('actor_id', '=', filter.actorId);
    if (filter.action) query = query.where('action', '=', filter.action);
    if (filter.targetType) query = query.where('target_type', '=', filter.targetType);
    if (filter.targetId) query = query.where('target_id', '=', filter.targetId);
    if (filter.before !== undefined) query = query.where('seq', '<', String(filter.before) as never);
    const rows = await query.orderBy('seq', 'desc').limit(filter.limit).execute();
    return rows.map(toAudit);
  }

  async *readBatches(batchSize: number): AsyncGenerator<AuditRecord[]> {
    let after = 0;
    for (;;) {
      const rows = await this.db
        .selectFrom('admin_audit_logs')
        .selectAll()
        .where('seq', '>', String(after) as never)
        .orderBy('seq')
        .limit(batchSize)
        .execute();
      if (rows.length === 0) return;
      const batch = rows.map(toAudit);
      yield batch;
      after = batch[batch.length - 1]!.seq;
    }
  }
}

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Db) {}

  async enqueue(message: { id: string; topic: string; payload: Record<string, unknown>; now: Date; availableAt?: Date }): Promise<void> {
    await this.db
      .insertInto('outbox')
      .values({ id: message.id, topic: message.topic, payload: json(message.payload), created_at: message.now, available_at: message.availableAt ?? message.now, last_error: null, processed_at: null, lease_owner: null, lease_until: null })
      .execute();
  }

  async claim(owner: string, now: Date, leaseUntil: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await sql<{ id: string; topic: string; payload: Record<string, unknown>; attempts: number }>`
      UPDATE outbox SET lease_owner = ${owner}, lease_until = ${leaseUntil}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
        WHERE processed_at IS NULL AND available_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY available_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, topic, payload, attempts`.execute(this.db);
    return rows.rows.map((row) => ({ id: row.id, topic: row.topic, payload: row.payload, attempts: row.attempts }));
  }

  async extendLease(ids: string[], owner: string, leaseUntil: Date): Promise<boolean> {
    if (ids.length === 0) return true;
    const result = await this.db.updateTable('outbox').set({ lease_until: leaseUntil }).where('id', 'in', ids).where('lease_owner', '=', owner).where('processed_at', 'is', null).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async purgeProcessed(before: Date): Promise<number> {
    const result = await this.db.deleteFrom('outbox').where('processed_at', '<', before).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async complete(id: string, owner: string, now: Date): Promise<void> {
    await this.db.updateTable('outbox').set({ processed_at: now, lease_owner: null, lease_until: null, last_error: null }).where('id', '=', id).where('lease_owner', '=', owner).execute();
  }

  async fail(id: string, owner: string, error: string, retryAt: Date | null): Promise<void> {
    // retryAt null = gave up: parked (never due again) but kept for inspection.
    await sql`
      UPDATE outbox SET lease_owner = NULL, lease_until = NULL, last_error = ${error.slice(0, 1000)},
        available_at = ${retryAt === null ? sql`'infinity'::timestamptz` : sql`${retryAt}`}
      WHERE id = ${id} AND lease_owner = ${owner}`.execute(this.db);
  }

  async stats(): Promise<{ pending: number; failing: number }> {
    const row = await sql<{ pending: string; failing: string }>`
      SELECT count(*) FILTER (WHERE processed_at IS NULL) AS pending,
             count(*) FILTER (WHERE processed_at IS NULL AND last_error IS NOT NULL) AS failing
      FROM outbox`.execute(this.db);
    return { pending: Number(row.rows[0]?.pending ?? 0), failing: Number(row.rows[0]?.failing ?? 0) };
  }
}

export class PgAdminUnitOfWork implements AdminUnitOfWork {
  constructor(private readonly db: Db) {}

  run<T>(work: (tx: AdminTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) =>
      work({
        staff: new PgStaffRepository(trx),
        staffSessions: new PgStaffSessionRepository(trx),
        audit: new PgAuditRepository(trx, true),
        outbox: new PgOutboxRepository(trx),
        sessions: new PgSessionRepository(trx),
      }),
    );
  }
}

export class PgAdminQueries implements AdminQueries {
  constructor(private readonly db: Db) {}

  async searchUsers(query: { text?: string | undefined; offset: number; limit: number }): Promise<{ items: AdminUserRecord[]; total: number }> {
    const text = query.text?.trim().toLowerCase();
    const filter = text ? (isEntityId(text) ? sql`u.id::text = ${text}` : sql`u.email LIKE ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`) : sql`true`;
    const [rows, total] = await Promise.all([
      sql<UserRow>`
        SELECT u.id, u.email, u.email_verified_at, u.created_at, u.last_seen_at,
          (SELECT count(*) FROM sources s WHERE s.owner_id = u.id) AS sources,
          (SELECT count(*) FROM sessions x WHERE x.user_id = u.id) AS sessions
        FROM users u WHERE ${filter}
        ORDER BY u.last_seen_at DESC
        OFFSET ${query.offset} LIMIT ${query.limit}`.execute(this.db),
      sql<{ count: string }>`SELECT count(*) AS count FROM users u WHERE ${filter}`.execute(this.db),
    ]);
    return { items: rows.rows.map(toAdminUser), total: Number(total.rows[0]?.count ?? 0) };
  }

  async findUser(id: string): Promise<AdminUserRecord | null> {
    const rows = await sql<UserRow>`
      SELECT u.id, u.email, u.email_verified_at, u.created_at, u.last_seen_at,
        (SELECT count(*) FROM sources s WHERE s.owner_id = u.id) AS sources,
        (SELECT count(*) FROM sessions x WHERE x.user_id = u.id) AS sessions
      FROM users u WHERE u.id::text = ${id}`.execute(this.db);
    return rows.rows[0] ? toAdminUser(rows.rows[0]) : null;
  }

  async userSources(userId: string): Promise<{ id: string; name: string; type: string; status: string; lastSuccessAt: Date | null }[]> {
    const rows = await this.db
      .selectFrom('sources')
      .select(['id', 'name', 'type', 'sync_status', 'sync_last_success_at'])
      .where('owner_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, type: row.type, status: row.sync_status, lastSuccessAt: row.sync_last_success_at }));
  }

  async overview(now: Date) {
    const since = new Date(now.getTime() - 24 * 3600_000);
    const row = await sql<Record<string, string>>`
      SELECT
        (SELECT count(*) FROM users) AS users_total,
        (SELECT count(*) FROM users WHERE email IS NOT NULL) AS users_registered,
        (SELECT count(*) FROM users WHERE last_seen_at >= ${since}) AS users_active,
        (SELECT count(*) FROM sources) AS sources_total,
        (SELECT count(*) FROM sources WHERE sync_status = 'failed') AS sources_failing,
        (SELECT count(*) FROM sources WHERE sync_status IN ('queued', 'running')) AS sources_syncing,
        (SELECT count(*) FROM sessions WHERE expires_at IS NULL OR expires_at > ${now}) AS sessions_active,
        (SELECT count(*) FROM staff_users WHERE disabled_at IS NULL) AS staff_total,
        (SELECT count(*) FROM staff_users WHERE disabled_at IS NULL AND mfa_enabled_at IS NULL) AS staff_without_mfa`.execute(this.db);
    const r = row.rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    return {
      users: { total: n('users_total'), registered: n('users_registered'), activeLast24h: n('users_active') },
      sources: { total: n('sources_total'), failing: n('sources_failing'), syncing: n('sources_syncing') },
      sessions: { active: n('sessions_active') },
      staff: { total: n('staff_total'), withoutMfa: n('staff_without_mfa') },
    };
  }
}

interface UserRow {
  id: string;
  email: string | null;
  email_verified_at: Date | null;
  created_at: Date;
  last_seen_at: Date;
  sources: string;
  sessions: string;
}

function toAdminUser(row: UserRow): AdminUserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    sources: Number(row.sources),
    sessions: Number(row.sessions),
  };
}
