import type { StaffRole } from '../../domain/admin/rbac.js';
import type { SessionRepository } from './session-repository.js';

/** Persistence ports of the operator console. */

export interface StaffRecord {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  /** Encrypted TOTP secret (null until enrolled). */
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  mfaLastStep: number | null;
  mustChangePassword: boolean;
  mfaFailures: number;
  lockedUntil: Date | null;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffWithPassword extends StaffRecord {
  passwordHash: string;
}

export interface StaffRepository {
  findByEmail(email: string): Promise<StaffWithPassword | null>;
  findById(id: string): Promise<StaffWithPassword | null>;
  list(): Promise<StaffRecord[]>;
  countActiveSuperAdmins(): Promise<number>;
  create(staff: { id: string; email: string; name: string; role: StaffRole; passwordHash: string; now: Date }): Promise<StaffRecord>;
  update(
    id: string,
    patch: Partial<{ name: string; role: StaffRole; disabledAt: Date | null; passwordHash: string; mustChangePassword: boolean; mfaSecret: string | null; mfaEnabledAt: Date | null; mfaLastStep: number | null; lastLoginAt: Date }>,
    now: Date,
  ): Promise<StaffRecord | null>;
  /** Accept a TOTP step only if it is newer than the last accepted one (atomic: no replay across instances). */
  claimMfaStep(id: string, step: number): Promise<boolean>;
  /** Stores the first TOTP secret; false when another enrolment won the race. */
  enrollMfa(id: string, sealedSecret: string, now: Date): Promise<boolean>;
  /** Counts a wrong code; at `limit` consecutive failures locks the account until `lockUntil`. True when this call locked it. */
  recordMfaFailure(id: string, limit: number, lockUntil: Date): Promise<boolean>;
  resetMfaFailures(id: string): Promise<void>;
  /** Serialises staff-administration transactions (e.g. the last-super-admin rule). */
  lockAdministration(): Promise<void>;
}

export interface StaffSessionRecord {
  id: string;
  staffId: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface StaffSessionRepository {
  create(session: StaffSessionRecord & { tokenHash: string; ip: string | null; userAgent: string | null }): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<{ session: StaffSessionRecord; staff: StaffRecord } | null>;
  touch(id: string, at: Date, idleExpiresAt: Date): Promise<void>;
  delete(id: string): Promise<void>;
  deleteForStaff(staffId: string, keepSessionId?: string): Promise<number>;
  purgeExpired(now: Date): Promise<number>;
}

export interface NewAuditEntry {
  occurredAt: Date;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}

export interface AuditRecord extends Omit<NewAuditEntry, 'occurredAt'> {
  seq: number;
  occurredAt: Date;
  prevHash: string;
  hash: string;
}

export interface AuditFilter {
  actorId?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** Entries with seq < before (pagination, newest first). */
  before?: number | undefined;
  limit: number;
}

export interface AuditRepository {
  /** Appends at the end of the hash chain (serialised: the chain never forks). Must run inside a unit of work. */
  append(entry: NewAuditEntry): Promise<AuditRecord>;
  list(filter: AuditFilter): Promise<AuditRecord[]>;
  /** Oldest first, for chain verification. */
  readBatches(batchSize: number): AsyncGenerator<AuditRecord[]>;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxRepository {
  enqueue(message: { id: string; topic: string; payload: Record<string, unknown>; now: Date; availableAt?: Date }): Promise<void>;
  /** Claims up to `limit` due messages under a lease. */
  claim(owner: string, now: Date, leaseUntil: Date, limit: number): Promise<OutboxMessage[]>;
  /** Keeps a long batch's messages leased (false when the lease was lost). */
  extendLease(ids: string[], owner: string, leaseUntil: Date): Promise<boolean>;
  purgeProcessed(before: Date): Promise<number>;
  complete(id: string, owner: string, now: Date): Promise<void>;
  fail(id: string, owner: string, error: string, retryAt: Date | null): Promise<void>;
  stats(): Promise<{ pending: number; failing: number }>;
}

/**
 * Repositories bound to one database transaction. Admin writes go through it so the change, its
 * audit entry and its outbox messages commit together — or not at all.
 */
export interface AdminTransaction {
  staff: StaffRepository;
  staffSessions: StaffSessionRepository;
  audit: AuditRepository;
  outbox: OutboxRepository;
  sessions: SessionRepository;
}

export interface AdminUnitOfWork {
  run<T>(work: (tx: AdminTransaction) => Promise<T>): Promise<T>;
}

export interface AdminUserRecord {
  id: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  sources: number;
  sessions: number;
}

/** Read models of the console (subscribers, system counters). */
export interface AdminQueries {
  searchUsers(query: { text?: string | undefined; offset: number; limit: number }): Promise<{ items: AdminUserRecord[]; total: number }>;
  findUser(id: string): Promise<AdminUserRecord | null>;
  userSources(userId: string): Promise<{ id: string; name: string; type: string; status: string; lastSuccessAt: Date | null }[]>;
  overview(now: Date): Promise<{
    users: { total: number; registered: number; activeLast24h: number };
    sources: { total: number; failing: number; syncing: number };
    sessions: { active: number };
    staff: { total: number; withoutMfa: number };
  }>;
}
