import type { GuideOrigin } from '@ziptv/contracts';

export interface GuideSyncState {
  status: 'idle' | 'queued' | 'running' | 'failed';
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  nextSyncAt: Date | null;
  error: string | null;
  consecutiveFailures: number;
  rerunRequested: boolean;
}

export interface GuideStats {
  channels: number;
  keptChannels: number;
  programmes: number;
  from: Date | null;
  to: Date | null;
}

/** EPG source: one XMLTV URL of a user, shared by the sources that use it. */
export interface GuideRecord {
  id: string;
  ownerId: string;
  name: string;
  origin: GuideOrigin;
  /** Encrypted XMLTV URL (may embed provider credentials). */
  url: string;
  /** sha256 of the URL — dedupe without decrypting. */
  urlHash: string;
  host: string;
  sourceIds: string[];
  /** Generation of channels/programmes currently visible (swapped atomically like source revisions). */
  generation: number;
  /** Set by claimDue: the generation number reserved for this run (unique per run, never reused). */
  claimedGeneration?: number;
  sync: GuideSyncState;
  stats: GuideStats;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewGuide {
  ownerId: string;
  name: string;
  origin: GuideOrigin;
  url: string;
  urlHash: string;
  host: string;
  sourceIds: string[];
  queuedAt: Date;
}

export interface GuideRepository {
  isValidId(id: string): boolean;
  listByOwner(ownerId: string): Promise<GuideRecord[]>;
  listForSource(ownerId: string, sourceId: string): Promise<GuideRecord[]>;
  findOwned(id: string, ownerId: string): Promise<GuideRecord | null>;
  findById(id: string): Promise<GuideRecord | null>;
  findByUrlHash(ownerId: string, urlHash: string): Promise<GuideRecord | null>;
  create(guide: NewGuide): Promise<GuideRecord>;
  update(id: string, ownerId: string, patch: { name?: string; sourceIds?: string[] }): Promise<GuideRecord | null>;
  attachSource(id: string, sourceId: string): Promise<void>;
  detachSource(ownerId: string, sourceId: string, guideIds?: string[]): Promise<void>;
  /** Guides created from source announcements that no source uses any more. */
  listOrphans(ownerId: string): Promise<GuideRecord[]>;
  delete(id: string): Promise<boolean>;

  requestSync(id: string, now: Date): Promise<GuideRecord | null>;
  claimDue(now: Date, owner: string, leaseUntil: Date): Promise<GuideRecord | null>;
  heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean>;
  commitGeneration(id: string, owner: string, expectedGeneration: number, generation: number, stats: GuideStats): Promise<GuideRecord | null>;
  completeSync(
    id: string,
    owner: string,
    outcome: { status: 'idle' | 'failed'; error: string | null; nextSyncAt: Date; consecutiveFailures: number; lastSuccessAt?: Date },
  ): Promise<GuideRecord | null>;
}

export interface GuideChannelRecord {
  id: string;
  names: string[];
  icon: string | null;
  /** Programmes of this channel are stored (it is linked, or matches a linked channel). */
  kept: boolean;
}

export interface GuideRef {
  guideId: string;
  generation: number;
}

export interface GuideChannelRepository {
  insertGeneration(ref: GuideRef, channels: GuideChannelRecord[]): Promise<void>;
  deleteGeneration(ref: GuideRef): Promise<void>;
  deleteOtherGenerations(ref: GuideRef): Promise<void>;
  deleteGuide(guideId: string): Promise<void>;
  list(ref: GuideRef): Promise<GuideChannelRecord[]>;
  find(ref: GuideRef, ids: string[]): Promise<GuideChannelRecord[]>;
  search(refs: GuideRef[], terms: string[], limit: number): Promise<(GuideChannelRecord & { guideId: string })[]>;
}

export interface ProgrammeRecord {
  channelId: string;
  start: Date;
  stop: Date;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
  episode: string | null;
  rating: string | null;
}

/** Programmes of some channels of one guide generation. */
export interface ProgrammeQuery extends GuideRef {
  channelIds: string[];
}

export interface ProgrammeRepository {
  insertGeneration(ref: GuideRef, programmes: ProgrammeRecord[]): Promise<void>;
  deleteGeneration(ref: GuideRef): Promise<void>;
  deleteOtherGenerations(ref: GuideRef): Promise<void>;
  deleteGuide(guideId: string): Promise<void>;
  /** Programmes overlapping [from, to), sorted by channel then start. */
  window(queries: ProgrammeQuery[], from: Date, to: Date): Promise<(ProgrammeRecord & { guideId: string })[]>;
  /** Text search over titles (prefix tokens) within [from, to), ordered by start (`desc` = most recent first). */
  search(refs: GuideRef[], terms: string[], from: Date, to: Date, limit: number, order?: 'asc' | 'desc'): Promise<(ProgrammeRecord & { guideId: string })[]>;
  /** Per channel, the first `perChannel` programmes that have not ended at `now` (now/next). */
  upcoming(queries: ProgrammeQuery[], now: Date, perChannel: number): Promise<(ProgrammeRecord & { guideId: string })[]>;
  /** How many of these channels have at least one programme in [from, to). */
  countChannelsWithProgrammes(query: ProgrammeQuery, from: Date, to: Date): Promise<number>;
  /** Drops programmes that ended before `cutoff` (between syncs). */
  deleteEndedBefore(cutoff: Date): Promise<number>;
}

export interface EpgMappingRecord {
  channelKey: string;
  guideId: string;
  epgChannelId: string;
}

/** Manual links chosen by the user; keyed by stable channel keys, so they survive syncs. */
export interface EpgMappingRepository {
  listForSource(ownerId: string, sourceId: string): Promise<EpgMappingRecord[]>;
  set(ownerId: string, sourceId: string, mapping: EpgMappingRecord): Promise<void>;
  remove(ownerId: string, sourceId: string, channelKey: string): Promise<boolean>;
  deleteForSource(ownerId: string, sourceId: string): Promise<void>;
  deleteForGuide(guideId: string): Promise<void>;
}
