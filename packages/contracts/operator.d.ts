// ---------------------------------------------------------------------------
// Operator catalog — licensed channels curated by the operator (alongside users' own sources)
// ---------------------------------------------------------------------------

export type DeviceClass = 'web' | 'mobile' | 'tv' | 'stb';
export type BusinessModel = 'subscription' | 'fast' | 'b2b';
export type ProviderType = 'm3u' | 'xtream' | 'mock';
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
  createdAt: string;
}

/**
 * Credentials are given either as a secret reference (`env:ZIPTV_SECRET_*`, preferred) whose value
 * is the JSON connection document, or as the connection itself (stored encrypted).
 * Connection: m3u `{ "url" }`, xtream `{ "server", "username", "password" }`.
 */
export type ProviderCredentialInput = { secretRef: string } | { connection: Record<string, string> };

export interface CreateProviderRequest {
  name: string;
  slug?: string;
  type: ProviderType;
  credential?: ProviderCredentialInput;
  /** Mock providers: `{ channels: [{ id, name, url, tvgId?, group?, kind? }] }`. */
  config?: Record<string, unknown>;
  syncIntervalHours?: number;
}

export interface UpdateProviderRequest {
  name?: string;
  status?: ProviderStatus;
  config?: Record<string, unknown>;
  syncIntervalHours?: number;
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
  items: MasterChannelDto[];
  total: number;
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
