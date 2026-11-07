// ---------------------------------------------------------------------------
// Operator catalog — licensed channels curated by the operator (alongside users' own sources)
// ---------------------------------------------------------------------------

export type DeviceClass = 'web' | 'mobile' | 'tv' | 'stb';
export type BusinessModel = 'subscription' | 'fast' | 'b2b';
/** vendor_feed = the signed ZIPTV Vendor Feed v1 (catalogue, VOD, packages and rights). */
export type ProviderType = 'm3u' | 'xtream' | 'mock' | 'vendor_feed';
export type Quality = 'sd' | 'hd' | 'fhd' | 'uhd';
export type ProviderStatus = 'active' | 'paused' | 'terminated';
export type ProviderStreamStatus = 'pending' | 'matched' | 'ignored' | 'gone';

/** Viewer: one channel of the operator lineup available in the viewer's market. */
export interface OperatorChannelDto {
  id: string;
  /** Lineup number (null when no lineup is selected / not numbered). */
  number: number | null;
  name: string;
  logo: string | null;
  category: string | null;
  languages: string[];
  favorite: boolean;
  /** Licensed here, but not in the viewer's packages (subscribe to one of `packages` to watch). */
  locked: boolean;
  packages: { slug: string; name: string }[];
  /** Days of archive this viewer may replay here (licensed catch-up × the feeds' archive); 0 = live only. */
  catchupDays: number;
  /** Locked by this profile's parental controls: playing it needs the PIN (unlock token). */
  parentalLock: boolean;
}

/** Phase 17 — where a film/series stands for this viewer: in their plan, in a plan they could switch to, or not sold. */
export type VodAccess = 'included' | 'upgrade' | 'unavailable';

/** `GET /operator/vod` — films and series the operator licenses here, with the viewer's access. */
export interface OperatorVodItemDto {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  poster: string | null;
  genres: string[];
  rating: number | null;
  access: VodAccess;
  /** Plans on sale that would open it (for `upgrade`). */
  plans: { slug: string; name: string }[];
  /** Picture ceiling for this viewer (licence × plan; null = none). */
  maxQuality: 'sd' | 'hd' | 'fhd' | 'uhd' | null;
}

/** `GET /operator/vod/:id` — one film/series with its episodes. */
export interface OperatorVodDetailDto extends OperatorVodItemDto {
  plot: string | null;
  durationSecs: number | null;
  episodes: { id: string; season: number; episode: number; title: string; durationSecs: number | null }[];
}

export interface OperatorVodPageDto {
  items: OperatorVodItemDto[];
  total: number;
}

export interface OperatorLineupDto {
  slug: string;
  name: string;
  country: string;
}

/** GET /operator/channels?country=&lineup=&device= */
export interface OperatorChannelListDto {
  /** Market the list was built for (null = unknown: only worldwide rights apply). */
  country: string | null;
  device: DeviceClass;
  lineup: OperatorLineupDto | null;
  /** Active lineups of the market. */
  lineups: OperatorLineupDto[];
  channels: OperatorChannelDto[];
}

export interface OperatorFavoritesImportDto {
  added: number;
}

// --- console (/admin/v1) ---------------------------------------------------------------------

export interface ProviderDto {
  id: string;
  slug: string;
  name: string;
  type: ProviderType;
  status: ProviderStatus;
  host: string;
  syncIntervalHours: number;
  sync: {
    status: 'idle' | 'queued' | 'running' | 'failed';
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextAt: string | null;
    error: string | null;
  };
  stats: { streams: number; matched: number; pending: number; gone: number };
  /** Where the credential lives — never the credential: `env:NAME` or `stored`. */
  credential: { source: string; rotatedAt: string } | null;
  contract: ProviderContractDto;
  /** Vendor feeds: incremental position and the generation time of the last feed applied. */
  feed: { cursor: string | null; generatedAt: string | null; keyIds: string[] } | null;
  createdAt: string;
}

/** GET /providers/:id/events — the sync journal, newest first. */
export interface ProviderSyncEventDto {
  id: string;
  at: string;
  level: 'info' | 'warning' | 'error';
  /** Stable machine code: sync_ok, sync_failed, signature_invalid, item_skipped, stale_feed, … */
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** GET /providers/:id/conflicts — what needs a decision. */
export interface ProviderConflictsDto {
  /** Staff grants wider than the provider licenses (territory, device, model or time not in its feed). */
  grantsBeyondFeed: { grantId: string; channelId: string; channelName: string; territory: string; reason: string }[];
  /** Streams waiting for review (no master channel matched them automatically). */
  pendingStreams: number;
  /** Items the last feed sync skipped (invalid), with the reason. */
  skippedItems: { path: string; message: string }[];
}

/** GET /providers/:id/content — what a vendor feed delivered besides channels. */
export interface ProviderContentDto {
  movies: number;
  series: number;
  episodes: number;
  packages: { externalId: string; name: string; status: 'active' | 'gone'; items: number }[];
  recent: { externalId: string; type: 'movie' | 'series'; title: string; year: number | null; status: 'active' | 'gone' }[];
}

export interface ProviderContractDto {
  ref: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Availability the licensor committed to (e.g. 99.5). */
  slaTargetPct: number | null;
  monthlyCost: { currency: string; amountMinor: number } | null;
  notes: string;
  /** Partner report (Phase 17): the licensor gets at least this per month. */
  minimumGuarantee: { currency: string; amountMinor: number } | null;
  /** How much a catch-up minute counts in the revenue share (1 = like a live minute, 0 = not at all). */
  catchupWeight: number;
  /** Separate catch-up tariff, per hour of catch-up viewing. */
  catchupFeePerHour: { currency: string; amountMinor: number } | null;
}

/**
 * Credentials are given either as a secret reference (`env:ZIPTV_SECRET_*`, preferred) whose value
 * is the JSON connection document, or as the connection itself (stored encrypted).
 * Connection: m3u `{ "url" }`, xtream `{ "server", "username", "password" }`,
 * vendor_feed `{ "url", "token"? }` (the vendor's public keys go in `config.publicKeys`).
 */
export type ProviderCredentialInput = { secretRef: string } | { connection: Record<string, string> };

export interface CreateProviderRequest {
  name: string;
  slug?: string;
  type: ProviderType;
  credential?: ProviderCredentialInput;
  /**
   * Mock providers: `{ channels: [{ id, name, url, tvgId?, group?, kind? }] }`.
   * Vendor feeds: `{ publicKeys: [{ id, key }] }` — Ed25519 public keys (base64 raw or PEM) the feed is signed with.
   */
  config?: Record<string, unknown>;
  syncIntervalHours?: number;
}

export interface UpdateProviderRequest {
  name?: string;
  status?: ProviderStatus;
  config?: Record<string, unknown>;
  syncIntervalHours?: number;
  contract?: {
    ref?: string | null;
    startAt?: string | null;
    endAt?: string | null;
    slaTargetPct?: number | null;
    monthlyCost?: { currency: string; amountMinor: number } | null;
    notes?: string;
    minimumGuarantee?: { currency: string; amountMinor: number } | null;
    catchupWeight?: number;
    catchupFeePerHour?: { currency: string; amountMinor: number } | null;
  };
}

export interface ProviderHealthDto {
  ok: boolean;
  latencyMs: number;
  message: string | null;
}

export interface ProviderStreamDto {
  id: string;
  providerId: string;
  externalId: string;
  name: string;
  tvgId: string | null;
  groups: string[];
  logo: string | null;
  kind: string;
  status: ProviderStreamStatus;
  channelId: string | null;
  matchMethod: 'tvg_id' | 'name' | 'manual' | null;
  suggestion: { id: string; name: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ProviderStreamPageDto {
  items: ProviderStreamDto[];
  total: number;
}

/** Review decision for a pending stream. */
export type ReviewStreamRequest =
  | { action: 'match'; channelId: string }
  | { action: 'create'; name?: string; originCountry?: string | null; languages?: string[]; categoryId?: string | null }
  | { action: 'ignore' };

export interface CategoryDto {
  id: string;
  slug: string;
  name: string;
}

export interface MasterChannelDto {
  id: string;
  slug: string;
  name: string;
  originCountry: string | null;
  languages: string[];
  categoryId: string | null;
  logo: string | null;
  globalUid: string | null;
  status: 'active' | 'hidden';
  createdAt: string;
  updatedAt: string;
}

export interface MasterChannelPageDto {
  items: (MasterChannelDto & MasterChannelStatsDto)[];
  total: number;
}

/** Console list columns: feeds, rights and the health of the feed on air. */
export interface MasterChannelStatsDto {
  feeds: number;
  playableFeeds: number;
  activeGrants: number;
  /** Health of the active (or best) feed; null = no feed. */
  health: 'HEALTHY' | 'UNHEALTHY' | 'GEO_BLOCKED' | 'NOT_ENTITLED' | 'MAINTENANCE' | 'PROVIDER_OUTAGE' | 'UNKNOWN' | null;
}

export interface FeedDto {
  id: string;
  providerId: string;
  providerName: string;
  streamId: string;
  streamName: string;
  priority: number;
  status: 'active' | 'disabled';
  /** Active, provider active and stream still offered. */
  playable: boolean;
}

export interface RightsGrantDto {
  id: string;
  territory: string;
  deviceClasses: DeviceClass[];
  businessModels: BusinessModel[];
  startAt: string;
  endAt: string | null;
  contractRef: string;
  /** Catch-up rights: how many days back viewers may replay (0 = live only). */
  catchupDays: number;
  /** Highest licensed picture quality; null = no limit. */
  maxQuality: Quality | null;
  /** manual = made in the console; feed = from the provider's signed feed (changes with it). */
  origin: 'manual' | 'feed';
  providerId: string | null;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

export interface MasterChannelDetailDto extends MasterChannelDto {
  aliases: { kind: 'name' | 'tvg_id' | 'manual'; key: string }[];
  feeds: FeedDto[];
  grants: RightsGrantDto[];
  lineups: { id: string; slug: string; number: number }[];
}

export interface CreateMasterChannelRequest {
  name: string;
  slug?: string;
  originCountry?: string | null;
  languages?: string[];
  categoryId?: string | null;
  logo?: string | null;
  globalUid?: string | null;
}

export type UpdateMasterChannelRequest = Partial<CreateMasterChannelRequest> & { status?: 'active' | 'hidden'; aliases?: string[] };

export interface MergeChannelsRequest {
  /** Channel that disappears; everything of it moves to the channel in the URL. */
  fromChannelId: string;
}

export interface UpdateFeedRequest {
  priority?: number;
  status?: 'active' | 'disabled';
}

export interface CreateGrantRequest {
  territory: string;
  deviceClasses: DeviceClass[];
  businessModels: BusinessModel[];
  startAt: string;
  endAt?: string | null;
  contractRef: string;
  /** Catch-up rights in days (0–30; default 0 = live only). */
  catchupDays?: number;
  /** Quality limit (default none). */
  maxQuality?: Quality | null;
}

export interface LineupDto {
  id: string;
  slug: string;
  name: string;
  country: string;
  status: 'draft' | 'active';
  channels: number;
}

export interface LineupDetailDto extends LineupDto {
  entries: { channelId: string; name: string; number: number }[];
}

export interface CreateLineupRequest {
  name: string;
  slug?: string;
  country: string;
  status?: 'draft' | 'active';
}

export interface UpdateLineupRequest {
  name?: string;
  status?: 'draft' | 'active';
  /** Replaces the whole numbering. */
  entries?: { channelId: string; number: number }[];
}
