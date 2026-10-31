import type { CatalogStats, CatalogWarning } from '../../domain/catalog/model.js';
import type { HealthState, SourceProblem, SourceType, SyncStage, SyncStatus } from '../../domain/sources/source.js';

export type SourceOrigin =
  | { kind: 'url'; host: string }
  | { kind: 'file'; fileName: string }
  | { kind: 'xtream'; host: string; username: string };

export interface SourceSyncState {
  status: SyncStatus;
  stage: SyncStage | null;
  autoSync: boolean;
  intervalHours: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  nextSyncAt: Date | null;
  error: { problem: SourceProblem; message: string } | null;
  consecutiveFailures: number;
  /** A sync was requested while one was running: run again right after it. */
  rerunRequested: boolean;
}

export interface SourceHealth {
  state: HealthState;
  checkedAt: Date | null;
  latencyMs: number | null;
  unstableStreams: number;
  offlineStreams: number;
  message: string | null;
}

export interface SourceAccount {
  status: string;
  expiresAt: Date | null;
  maxConnections: number | null;
  activeConnections: number | null;
  trial: boolean;
}

export interface SourceRecord {
  id: string;
  ownerId: string;
  name: string;
  type: SourceType;
  origin: SourceOrigin;
  /** Encrypted `SourceCredential` JSON; null for file sources. */
  credential: string | null;
  revision: number;
  /** Bumped whenever guide links of the current revision change (part of catalogVersion). */
  epgVersion: number;
  stats: CatalogStats;
  sync: SourceSyncState;
  health: SourceHealth;
  account: SourceAccount | null;
  /** Encrypted XMLTV URLs announced by the source. */
  epgUrls: string[];
  warnings: CatalogWarning[];
  warningCount: number;
  format: string;
  encoding: string;
  xtreamCandidate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSource {
  id: string;
  ownerId: string;
  name: string;
  type: SourceType;
  origin: SourceOrigin;
  credential: string | null;
  sync: SourceSyncState;
}

/** Data of a successfully built revision, swapped in atomically. */
export interface RevisionSnapshot {
  revision: number;
  stats: CatalogStats;
  epgUrls: string[];
  warnings: CatalogWarning[];
  warningCount: number;
  format: string;
  encoding: string;
  account: SourceAccount | null;
  xtreamCandidate: boolean;
}

export interface SyncOutcome {
  status: 'idle' | 'failed';
  error: { problem: SourceProblem; message: string } | null;
  lastSuccessAt?: Date;
  nextSyncAt: Date | null;
  consecutiveFailures: number;
  account?: SourceAccount | null;
}

export interface SourceSettingsPatch {
  name?: string;
  /** M3U URL → Xtream conversion (together with credential + origin). */
  type?: SourceType;
  xtreamCandidate?: boolean;
  /** Apply only while the source still has this type (guards a conversion against a racing edit). */
  ifType?: SourceType;
  autoSync?: boolean;
  intervalHours?: number;
  nextSyncAt?: Date | null;
  credential?: string;
  origin?: SourceOrigin;
}

export interface SourceRepository {
  newId(): string;
  isValidId(id: string): boolean;
  countByOwner(ownerId: string): Promise<number>;
  listByOwner(ownerId: string): Promise<SourceRecord[]>;
  findOwned(id: string, ownerId: string): Promise<SourceRecord | null>;
  findById(id: string): Promise<SourceRecord | null>;
  create(source: NewSource): Promise<SourceRecord>;
  updateSettings(id: string, ownerId: string, patch: SourceSettingsPatch): Promise<SourceRecord | null>;
  deleteOwned(id: string, ownerId: string): Promise<boolean>;
  listAllIds(): Promise<{ id: string; ownerId: string }[]>;

  // --- background sync (lease-based, safe with several instances) -------------------------
  /** Marks a sync as wanted now; when one is running, it reruns right after. */
  requestSync(id: string, now: Date): Promise<SourceRecord | null>;
  /**
   * Claims one source that needs syncing (queued, due, or a running sync whose lease expired)
   * and marks it running for `owner` until `leaseUntil`.
   */
  claimDue(now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null>;
  /** Claims a specific source for an in-request sync (file uploads). */
  claim(id: string, now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null>;
  /** Extends the lease; false = the lease was lost (another instance took over). */
  heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean>;
  setStage(id: string, owner: string, stage: SyncStage): Promise<void>;
  /** Compare-and-set on `revision` (and lease): null when the swap lost a race. */
  commitRevision(id: string, owner: string, expectedRevision: number, snapshot: RevisionSnapshot): Promise<SourceRecord | null>;
  /** Releases the lease with the outcome. A pending rerun puts the source back in the queue. */
  completeSync(id: string, owner: string, outcome: SyncOutcome): Promise<SourceRecord | null>;

  // --- derived state -------------------------------------------------------------------------
  /** Updates EPG mapping stats of the current revision; bumps `epgVersion` when links changed. */
  setEpgState(id: string, revision: number, epgMapped: number, linksChanged: boolean): Promise<void>;
  updateHealth(id: string, health: SourceHealth): Promise<void>;
  updateAccount(id: string, account: SourceAccount): Promise<void>;
}
