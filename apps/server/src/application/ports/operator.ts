import type { CatchupInfo, StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import type { AliasKind, BusinessModel, DeviceClass, MatchMethod, ProviderStatus, ProviderType, StreamStatus } from '../../domain/operator/catalog.js';
import type { RightsGrant } from '../../domain/operator/rights.js';
import type { FeedIssue, FeedRight, Quality } from '../../domain/operator/vendor-feed.js';

// ---------------------------------------------------------------------------------------------
// Provider connectors
// ---------------------------------------------------------------------------------------------

/** Connection document a provider credential resolves to (stored behind a secret reference). */
export type ProviderConnection =
  | { type: 'm3u'; url: string }
  | { type: 'xtream'; server: string; username: string; password: string }
  | { type: 'vendor_feed'; url: string; token: string | null }
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
  /** The provider's archive of this stream (catch-up), if any. */
  catchup: CatchupInfo | null;
  /** Vendor feeds: the rights the vendor licenses this channel under (null = the feed says nothing; staff grants decide). */
  rights?: FeedRight[] | null;
}

/** Movies/series a provider offers (vendor feeds), locators already sealed by the sync. */
export interface ProviderVodItem {
  externalId: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  genres: string[];
  poster: string | null;
  plot: string | null;
  durationSecs: number | null;
  rating: number | null;
  locator: StreamLocator | null;
  episodes: { externalId: string; season: number; episode: number; title: string; durationSecs: number | null; locator: StreamLocator }[];
  rights: FeedRight[];
  packages: string[];
}

/**
 * Everything a full-catalogue provider (vendor feed) delivered in one sync: a complete snapshot
 * (`full`) or the changes since `cursor`.
 */
export interface ProviderCatalogDelta {
  full: boolean;
  cursor: string;
  generatedAt: Date;
  channels: ProviderChannel[];
  vod: ProviderVodItem[];
  packages: { externalId: string; name: string; description: string | null; channelIds: string[]; vodIds: string[] }[];
  deleted: { channels: string[]; vod: string[]; packages: string[] };
  epgUrls: string[];
  /** Items left out because they were invalid (the rest applies). */
  issues: FeedIssue[];
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
  /** Archive address of [start, end) on this stream; null when the stream has no usable archive. */
  resolveArchive(provider: ProviderRecord, connection: ProviderConnection, stream: ProviderStreamRecord, times: { start: Date; end: Date; now: Date }): Promise<StreamLocator | null>;
  health(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<ProviderHealth>;
  /**
   * Full-catalogue providers (channels, VOD, packages, rights — incremental): the changes since
   * `cursor` (null = everything). Channel-list providers (M3U, Xtream) do not implement it and are
   * synced with `listChannels`.
   */
  fetchCatalog?(provider: ProviderRecord, connection: ProviderConnection, cursor: string | null, signal: AbortSignal): Promise<ProviderCatalogDelta>;
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
  contract: ProviderContract;
  /** Incremental syncs: where the last one ended, and when the last feed applied was generated. */
  feed: { cursor: string | null; generatedAt: Date | null };
  createdAt: Date;
}

export interface ProviderContract {
  ref: string | null;
  startAt: Date | null;
  endAt: Date | null;
  slaTargetPct: number | null;
  monthlyCostMinor: number | null;
  costCurrency: string | null;
  notes: string;
  /** Phase 17 — partner report terms. Minimum guarantee per month. */
  minimumGuarantee: { amountMinor: number; currency: string } | null;
  /** How much a catch-up minute counts in the revenue share (1 = like live). */
  catchupWeight: number;
  /** Separate catch-up tariff per viewing hour. */
  catchupFeePerHour: { amountMinor: number; currency: string } | null;
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
  catchup: CatchupInfo | null;
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
  /** Joined: days of archive the provider keeps for this stream (0 = no catch-up). */
  archiveDays: number;
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
  catchupDays: number;
  /** Highest licensed quality (null/absent = no limit). */
  maxQuality?: Quality | null;
  createdBy: string | null;
}

export interface StoredGrant extends RightsGrant {
  /** manual = made by staff; feed = kept in step with a vendor's signed feed by the sync. */
  origin: 'manual' | 'feed';
  providerId: string | null;
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
  updateProvider(id: string, patch: { name?: string; status?: ProviderStatus; config?: Record<string, unknown>; host?: string; syncIntervalHours?: number; contract?: Partial<ProviderContract> }): Promise<ProviderRecord | null>;
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
