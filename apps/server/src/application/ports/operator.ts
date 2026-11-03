import type { StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import type { AliasKind, BusinessModel, DeviceClass, MatchMethod, ProviderStatus, ProviderType, StreamStatus } from '../../domain/operator/catalog.js';
import type { RightsGrant } from '../../domain/operator/rights.js';

// ---------------------------------------------------------------------------------------------
// Provider connectors
// ---------------------------------------------------------------------------------------------

/** Connection document a provider credential resolves to (stored behind a secret reference). */
export type ProviderConnection =
  | { type: 'm3u'; url: string }
  | { type: 'xtream'; server: string; username: string; password: string }
  | { type: 'mock' };

/** One channel a provider offers, as its connector reports it. */
export interface ProviderChannel {
  /** Stable id within the provider (survives provider syncs). */
  externalId: string;
  name: string;
  tvgId: string | null;
  groups: string[];
  logo: string | null;
  kind: StreamKind;
  /** M3U: the stream address (stored encrypted, server-side only). */
  locator: StreamLocator | null;
  /** Xtream: stream id (the URL is built from the credential at play time). */
  xtream: { id: number } | null;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number;
  message: string | null;
}

/**
 * A licensed provider integration. Connectors never return credentials to callers outside the
 * server; `resolveFeed` produces the upstream address only for the stream proxy.
 */
export interface ProviderAdapter {
  listChannels(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<{ channels: ProviderChannel[]; epgUrls: string[] }>;
  resolveFeed(provider: ProviderRecord, connection: ProviderConnection, stream: ProviderStreamRecord): Promise<StreamLocator>;
  health(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<ProviderHealth>;
}

export type ProviderAdapters = Readonly<Record<ProviderType, ProviderAdapter>>;

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface ProviderStats {
  streams: number;
  matched: number;
  pending: number;
  gone: number;
}

export interface ProviderRecord {
  id: string;
  slug: string;
  name: string;
  status: ProviderStatus;
  type: ProviderType;
  config: Record<string, unknown>;
  host: string;
  syncIntervalHours: number;
  sync: {
    status: 'idle' | 'queued' | 'running' | 'failed';
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    nextAt: Date | null;
    error: string | null;
    failures: number;
  };
  stats: ProviderStats;
  credential: { secretRef: string; rotatedAt: Date } | null;
  createdAt: Date;
}

export interface ProviderStreamRecord {
  id: string;
  providerId: string;
  externalId: string;
  name: string;
  tvgId: string | null;
  groups: string[];
  logo: string | null;
  kind: StreamKind;
  /** Encrypted locator. */
  locator: string | null;
  xtream: { id: number } | null;
  status: StreamStatus;
  channelId: string | null;
  matchMethod: MatchMethod | null;
  suggestion: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface CategoryRecord {
  id: string;
  slug: string;
  name: string;
}

export interface MasterChannelRecord {
  id: string;
  slug: string;
  name: string;
  originCountry: string | null;
  languages: string[];
  categoryId: string | null;
  logo: string | null;
  globalUid: string | null;
  status: 'active' | 'hidden';
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedRecord {
  id: string;
  channelId: string;
  providerId: string;
  providerStreamId: string;
  priority: number;
  status: 'active' | 'disabled';
  createdAt: Date;
  /** Joined: for playability decisions. */
  providerStatus: ProviderStatus;
  streamStatus: StreamStatus;
}

export interface LineupRecord {
  id: string;
  slug: string;
  name: string;
  country: string;
  status: 'draft' | 'active';
  channels: number;
}

export interface NewGrant {
  id: string;
  channelId: string;
  territory: string;
  deviceClasses: DeviceClass[];
  businessModels: BusinessModel[];
  startAt: Date;
  endAt: Date | null;
  contractRef: string;
  createdBy: string | null;
}

export interface StoredGrant extends RightsGrant {
  contractRef: string;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

export interface StreamUpsert extends Omit<ProviderChannel, 'locator'> {
  locator: string | null;
}

/**
 * The operator catalog. Write methods are also available inside an admin transaction (so a
 * change and its audit entry commit together).
 */
export interface OperatorCatalogRepository {
  newId(): string;

  // providers
  listProviders(): Promise<ProviderRecord[]>;
  findProvider(id: string): Promise<ProviderRecord | null>;
  createProvider(input: { id: string; slug: string; name: string; type: ProviderType; config: Record<string, unknown>; host: string; syncIntervalHours: number; secretRef: string | null }): Promise<ProviderRecord>;
  updateProvider(id: string, patch: { name?: string; status?: ProviderStatus; config?: Record<string, unknown>; host?: string; syncIntervalHours?: number }): Promise<ProviderRecord | null>;
  setCredential(id: string, secretRef: string, now: Date): Promise<void>;
  requestProviderSync(id: string, now: Date): Promise<boolean>;
  claimDueProvider(now: Date, owner: string, leaseUntil: Date): Promise<ProviderRecord | null>;
  heartbeatProvider(id: string, owner: string, leaseUntil: Date): Promise<boolean>;
  completeProviderSync(id: string, owner: string, result: { ok: boolean; error: string | null; stats?: ProviderStats; nextAt: Date; now: Date }): Promise<void>;

  // streams (ingestion)
  listStreams(providerId: string): Promise<ProviderStreamRecord[]>;
  /** `lock`: row lock until the transaction ends (decisions on one stream are serialised). */
  findStream(id: string, options?: { lock?: boolean }): Promise<ProviderStreamRecord | null>;
  /** Inserts new streams / refreshes seen ones; returns ids by external id. */
  upsertStreams(providerId: string, streams: StreamUpsert[], now: Date): Promise<Map<string, ProviderStreamRecord>>;
  /** Streams of the provider not seen since `seenBefore` become `gone`; returns how many. */
  markGone(providerId: string, seenBefore: Date): Promise<number>;
  /** With `expected`, only changes a stream still in that status (false when it was not). */
  setStreamState(id: string, patch: { status: StreamStatus; channelId?: string | null; matchMethod?: MatchMethod | null; suggestion?: string | null }, expected?: StreamStatus): Promise<boolean>;
  reviewQueue(query: { providerId?: string | undefined; status: StreamStatus; offset: number; limit: number }): Promise<{ items: ProviderStreamRecord[]; total: number }>;
  providerStats(providerId: string): Promise<ProviderStats>;

  // channels & aliases
  listCategories(): Promise<CategoryRecord[]>;
  createCategory(input: { id: string; slug: string; name: string }): Promise<CategoryRecord>;
  listChannels(query: { text?: string | undefined; status?: 'active' | 'hidden' | undefined; offset: number; limit: number }): Promise<{ items: MasterChannelRecord[]; total: number }>;
  findChannel(id: string): Promise<MasterChannelRecord | null>;
  findChannels(ids: string[]): Promise<MasterChannelRecord[]>;
  slugExists(slug: string): Promise<boolean>;
  createChannel(input: Omit<MasterChannelRecord, 'createdAt' | 'updatedAt'>): Promise<MasterChannelRecord>;
  updateChannel(id: string, patch: Partial<Omit<MasterChannelRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<MasterChannelRecord | null>;
  /** Channels by alias keys: (kind, key) → channel id. */
  channelsByAlias(keys: { kind: AliasKind; key: string }[]): Promise<Map<string, string>>;
  /** Adds aliases that are not taken yet (an alias always points at one channel). */
  addAliases(channelId: string, keys: { kind: AliasKind; key: string }[]): Promise<void>;
  aliasesOf(channelId: string): Promise<{ kind: AliasKind; key: string }[]>;
  /** Moves everything of `fromId` (aliases, feeds, grants, lineups, favourites, history) to `intoId` and deletes `fromId`. */
  mergeChannels(fromId: string, intoId: string): Promise<void>;

  // feeds
  feedsOf(channelIds: string[]): Promise<FeedRecord[]>;
  /** Idempotent per stream: returns the stream's feed (an existing one wins). */
  createFeed(input: { id: string; channelId: string; providerId: string; providerStreamId: string; priority: number }): Promise<FeedRecord>;
  findFeedByStream(providerStreamId: string): Promise<FeedRecord | null>;
  findFeed(id: string): Promise<FeedRecord | null>;
  updateFeed(id: string, patch: { priority?: number; status?: 'active' | 'disabled' }): Promise<FeedRecord | null>;
  deleteFeed(id: string): Promise<boolean>;

  // rights
  grantsOf(channelIds: string[]): Promise<StoredGrant[]>;
  findGrant(id: string): Promise<StoredGrant | null>;
  createGrant(input: NewGrant): Promise<StoredGrant>;
  revokeGrant(id: string, now: Date): Promise<StoredGrant | null>;

  // lineups
  listLineups(): Promise<LineupRecord[]>;
  findLineup(idOrSlug: string): Promise<LineupRecord | null>;
  createLineup(input: { id: string; slug: string; name: string; country: string; status: 'draft' | 'active' }): Promise<LineupRecord>;
  updateLineup(id: string, patch: { name?: string; status?: 'draft' | 'active' }): Promise<LineupRecord | null>;
  lineupEntries(lineupId: string): Promise<{ channelId: string; number: number }[]>;
  /** Replaces the whole numbering of a lineup. */
  setLineupEntries(lineupId: string, entries: { channelId: string; number: number }[]): Promise<void>;
  /** Active lineups of a market. */
  lineupsForCountry(country: string): Promise<LineupRecord[]>;

  // viewer side
  activeChannelsWithFeeds(): Promise<MasterChannelRecord[]>;
  favorites(profileId: string): Promise<{ channelId: string; addedAt: Date }[]>;
  addFavorite(profileId: string, channelId: string): Promise<void>;
  removeFavorite(profileId: string, channelId: string): Promise<boolean>;
}
