import type { ChannelDto, MovieDto, SeriesDto } from './catalog';
import type { PageDto } from './common';
import type { EpgSearchItemDto, ProgrammeDto } from './epg';
import type { SourceDto } from './sources';

// ---------------------------------------------------------------------------
// My List (favorites for channels, movies and series) — per profile
// ---------------------------------------------------------------------------

export type ListItemType = 'channel' | 'movie' | 'series';

export interface ListItemDto {
  type: ListItemType;
  sourceId: string;
  key: string;
  title: string;
  image: string | null;
  /** Group/category or year, for the card subtitle. */
  subtitle: string | null;
  addedAt: string;
  /** False when the item disappeared from its source on the last sync. */
  available: boolean;
}

export interface ListStateDto {
  items: ListItemDto[];
}

// ---------------------------------------------------------------------------
// Continue watching (progress) — movies and episodes
// ---------------------------------------------------------------------------

export type ProgressContentType = 'movie' | 'episode';

export interface ProgressItemDto {
  contentType: ProgressContentType;
  sourceId: string;
  key: string;
  seriesKey: string | null;
  season: number | null;
  episode: number | null;
  title: string;
  /** Series name for episodes. */
  seriesTitle: string | null;
  image: string | null;
  position: number;
  duration: number;
  completed: boolean;
  remainingSecs: number;
  updatedAt: string;
}

export interface SaveProgressRequest {
  contentType: ProgressContentType;
  sourceId: string;
  key: string;
  seriesKey?: string;
  position: number;
  duration: number;
}

// ---------------------------------------------------------------------------
// Watch history — separate from progress: every viewing, live channels included
// ---------------------------------------------------------------------------

export type HistoryContentType = 'channel' | 'movie' | 'episode' | 'catchup';

export interface HistoryItemDto {
  id: string;
  contentType: HistoryContentType;
  sourceId: string;
  key: string;
  seriesKey: string | null;
  title: string;
  subtitle: string | null;
  image: string | null;
  startedAt: string;
  /** Last activity of this viewing. */
  watchedAt: string;
  watchedSecs: number;
  /** Catch-up: programme start/end, to replay it. */
  programmeStart: string | null;
  programmeEnd: string | null;
}

export type HistoryPageDto = PageDto<HistoryItemDto>;

/** One-time import of the 2.x per-browser favorites/recents (playlist id → channel keys). */
export interface ImportLocalStateRequest {
  favorites: Record<string, string[]>;
  recents: Record<string, string[]>;
}

export interface ImportLocalStateDto {
  favorites: number;
  recents: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePreference = 'dark' | 'light' | 'system';
export type QualityPreference = 'auto' | 'highest' | 'lowest' | '1080' | '720' | '480';
export type StartPage = 'home' | 'live' | 'guide' | 'movies' | 'series';

export interface PlaybackSettingsDto {
  autoplay: boolean;
  autoplayNextEpisode: boolean;
  resumePlayback: boolean;
  preferredQuality: QualityPreference;
  /** BCP-47 language code or '' for the stream default. */
  preferredAudio: string;
  /** BCP-47 language code, '' for the stream default, 'off' for none. */
  preferredSubtitles: string;
  /** Off = software decoding hints (mpegts.js worker off, hls.js no worker). */
  hardwareAcceleration: boolean;
}

export interface GeneralSettingsDto {
  startPage: StartPage;
  /** 24-hour clock in the guide. */
  use24hClock: boolean;
}

export interface AppearanceSettingsDto {
  theme: ThemePreference;
}

export interface EpgSettingsDto {
  /** Shift every programme time by N minutes (badly timed provider guides). */
  timeShiftMinutes: number;
  showProgress: boolean;
}

export interface ParentalSettingsDto {
  pinSet: boolean;
  /** Hide adult groups/channels everywhere (kids profiles always hide them). */
  hideAdult: boolean;
  lockedGroups: { sourceId: string; group: string }[];
  lockedChannels: { sourceId: string; key: string; name: string }[];
}

export interface DataSettingsDto {
  /** Watch history older than this is deleted (0 = keep forever). */
  historyRetentionDays: number;
}

export interface SettingsDto {
  general: GeneralSettingsDto;
  playback: PlaybackSettingsDto;
  appearance: AppearanceSettingsDto;
  epg: EpgSettingsDto;
  parental: ParentalSettingsDto;
  data: DataSettingsDto;
}

export interface UpdateSettingsRequest {
  general?: Partial<GeneralSettingsDto>;
  playback?: Partial<PlaybackSettingsDto>;
  appearance?: Partial<AppearanceSettingsDto>;
  epg?: Partial<EpgSettingsDto>;
  data?: Partial<DataSettingsDto>;
}

export interface StorageUsageDto {
  sources: number;
  liveChannels: number;
  movies: number;
  series: number;
  guides: number;
  programmes: number;
  myList: number;
  progress: number;
  history: number;
}

export type ClearableData = 'history' | 'progress' | 'my_list' | 'cache';

// --- Parental controls ------------------------------------------------------------------------

export interface SetPinRequest {
  /** Required when a PIN already exists. */
  currentPin?: string;
  pin: string;
}

export interface UnlockRequest {
  pin: string;
}

export interface UnlockDto {
  /** Send as `unlockToken` (playback) or `X-Unlock-Token` header. */
  token: string;
  expiresAt: string;
}

export interface UpdateParentalRulesRequest {
  pin: string;
  hideAdult?: boolean;
  lockedGroups?: { sourceId: string; group: string }[];
  lockedChannels?: { sourceId: string; key: string }[];
}

// ---------------------------------------------------------------------------
// Home dashboard — GET /home returns every rail in one response
// ---------------------------------------------------------------------------

export interface LiveNowItemDto {
  sourceId: string;
  channel: ChannelDto;
  now: ProgrammeDto | null;
  next: ProgrammeDto | null;
}

export interface RecentlyAddedItemDto {
  type: 'channel' | 'movie' | 'series';
  sourceId: string;
  key: string;
  title: string;
  image: string | null;
  addedAt: string;
}

export interface HomeDto {
  continueWatching: ProgressItemDto[];
  liveNow: LiveNowItemDto[];
  favorites: ListItemDto[];
  recentlyWatched: HistoryItemDto[];
  sportsLive: LiveNowItemDto[];
  movies: MovieDto[];
  series: SeriesDto[];
  recentlyAdded: RecentlyAddedItemDto[];
  /** Sources still syncing / failed, so Home can explain empty rails. */
  sources: SourceDto[];
}

// ---------------------------------------------------------------------------
// Unified search — GET /search?q=
// ---------------------------------------------------------------------------

export interface ChannelSearchItemDto {
  sourceId: string;
  sourceName: string;
  channel: ChannelDto;
}

export interface SearchResultDto {
  query: string;
  channels: ChannelSearchItemDto[];
  movies: MovieDto[];
  series: SeriesDto[];
  programmes: EpgSearchItemDto[];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'source_synced'
  | 'source_failed'
  | 'channels_added'
  | 'epg_updated'
  | 'epg_failed'
  | 'streams_unavailable'
  | 'account_expiring';

export interface NotificationDto {
  id: string;
  type: NotificationType;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
  /** In-app route to open, e.g. `/sources`. */
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationListDto {
  items: NotificationDto[];
  unread: number;
}
