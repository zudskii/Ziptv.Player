import type { FeedRight } from '../../domain/operator/vendor-feed.js';
import type { StoredGrant } from './operator.js';

export type SyncEventLevel = 'info' | 'warning' | 'error';

export interface ProviderSyncEvent {
  id: string;
  providerId: string;
  at: Date;
  level: SyncEventLevel;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface NewSyncEvent {
  level: SyncEventLevel;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A movie/series as stored: locators sealed. */
export interface SealedVod {
  externalId: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  genres: string[];
  genreIds: string[];
  poster: string | null;
  plot: string | null;
  durationSecs: number | null;
  rating: number | null;
  locator: string | null;
  episodes: { externalId: string; season: number; episode: number; title: string; durationSecs: number | null; locator: string | null }[];
  rights: FeedRight[];
  packages: string[];
}

/** One grant a vendor feed licenses (single territory, like every rights grant). */
export interface FeedGrantSpec {
  territory: string;
  deviceClasses: FeedRight['devices'];
  businessModels: FeedRight['models'];
  startAt: Date;
  endAt: Date | null;
  catchupDays: number;
  maxQuality: FeedRight['maxQuality'];
}

export interface ProviderContentSummary {
  movies: number;
  series: number;
  episodes: number;
  packages: { externalId: string; name: string; status: 'active' | 'gone'; items: number }[];
  recent: { externalId: string; type: 'movie' | 'series'; title: string; year: number | null; status: 'active' | 'gone' }[];
}

/** A licensed film/series as the viewer catalogue sees it (Phase 17). */
export interface VodCatalogItem {
  id: string;
  providerId: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  poster: string | null;
  genres: string[];
  rating: number | null;
  rights: FeedRight[];
  /** provider_packages ids it belongs to. */
  packageIds: string[];
}

export interface VodCatalogQuery {
  country: string | null;
  device: FeedRight['devices'][number];
  at: Date;
  type?: 'movie' | 'series' | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

/**
 * What full-catalogue providers (vendor feeds) add to the operator catalogue: the sync journal,
 * the incremental position, VOD and packages, and the rights grants kept in step with the feed.
 */
export interface ProviderFeedRepository {
  /** Appends to the provider's sync journal (the oldest entries beyond the retention are dropped). */
  recordEvents(providerId: string, events: readonly NewSyncEvent[], at: Date): Promise<void>;
  events(providerId: string, limit: number): Promise<ProviderSyncEvent[]>;

  setFeedPosition(providerId: string, cursor: string, generatedAt: Date): Promise<void>;

  /** Feed rights of streams, by external id (null = the feed gave none). */
  setStreamRights(providerId: string, rights: ReadonlyMap<string, FeedRight[] | null>): Promise<void>;
  /** Streams the feed deleted. Returns how many changed. */
  markStreamsGone(providerId: string, externalIds: readonly string[]): Promise<number>;

  upsertVod(providerId: string, items: readonly SealedVod[], now: Date): Promise<void>;
  /** By id, or (full snapshot) everything not seen since `seenBefore`. */
  markVodGone(providerId: string, which: { externalIds: readonly string[] } | { seenBefore: Date }): Promise<number>;
  upsertPackages(providerId: string, packages: readonly { externalId: string; name: string; description: string | null }[], now: Date): Promise<void>;
  markPackagesGone(providerId: string, which: { externalIds: readonly string[] } | { seenBefore: Date }): Promise<number>;
  content(providerId: string): Promise<ProviderContentSummary>;
  /** Vendor packages of every provider (the console's VOD plan picker). */
  packageOptions(): Promise<{ id: string; providerId: string; providerName: string; name: string; items: number; status: 'active' | 'gone' }[]>;
  /**
   * Films/series of active providers with a vendor right for this country and device at `at`
   * under a sellable model (subscription or B2B); the entitlement engine decides the rest.
   */
  vodCatalog(query: VodCatalogQuery): Promise<{ items: VodCatalogItem[]; total: number }>;
  /** One active film/series of an active provider, with its sealed stream locators. */
  vodItem(id: string): Promise<(VodCatalogItem & { plot: string | null; durationSecs: number | null; locator: string | null; episodes: { externalId: string; season: number; episode: number; title: string; durationSecs: number | null; locator: string | null }[] }) | null>;

  /** Channel ids whose matched streams from this provider carry feed rights (or had feed grants). */
  feedChannels(providerId: string): Promise<string[]>;
  /** Feed rights of a channel's matched streams, per provider (null = the feed gave none). */
  streamRightsOfChannel(channelId: string): Promise<{ providerId: string; rights: FeedRight[] | null }[]>;
  /**
   * Makes the channel's active feed grants from `providerId` exactly `grants`: unchanged ones stay,
   * missing ones are created, others revoked. Returns what changed.
   */
  replaceFeedGrants(channelId: string, providerId: string, contractRef: string, grants: readonly FeedGrantSpec[], now: Date): Promise<{ added: number; revoked: StoredGrant[] }>;
}
