/**
 * Catalog domain model: what a source contains once it has been read.
 *
 *   Source ──┬── LiveChannel            (Live TV, EPG, catch-up)
 *            ├── Movie                  (VOD)
 *            └── Series ── Season ── Episode
 *
 * Entries are produced by provider adapters (M3U, Xtream) and stored as one immutable
 * revision per sync. Stream URLs ("locators") are secrets: they usually embed the user's
 * provider credentials, so they never leave the server and are encrypted at rest.
 */

export type StreamKind = 'hls' | 'dash' | 'mpegts' | 'flv' | 'progressive' | 'unknown';

export type UnplayableReason = 'unsupported_protocol' | 'drm' | 'web_page';

/** Whitelisted upstream request headers a stream needs (lower-case names). */
export type StreamHeaders = Partial<Record<'user-agent' | 'referer' | 'origin' | 'cookie' | 'authorization', string>>;

/** Where a stream is — decrypted only for playback. */
export interface StreamLocator {
  url: string;
  headers: StreamHeaders;
}

/**
 * Archive (catch-up) capability of a live channel.
 *  - default/append/shift/flussonic: M3U `catchup=` conventions (TiviMate/Kodi/OTT Navigator).
 *  - xtream: Xtream Codes `timeshift.php` archive.
 */
export type CatchupMode = 'default' | 'append' | 'shift' | 'flussonic' | 'xtream';

export interface CatchupInfo {
  mode: CatchupMode;
  days: number;
  /** `catchup-source` template (may be relative to the stream URL); null = mode default. */
  template: string | null;
}

/** Link of a live channel to a guide channel (set by the EPG matcher). */
export interface EpgLink {
  guideId: string;
  epgChannelId: string;
  match: 'manual' | 'tvg-id' | 'name';
}

export interface LiveChannelEntry {
  key: string;
  position: number;
  name: string;
  groups: string[];
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  /** M3U sources: URL + headers. Xtream sources: null (built from credentials + `xtream.id`). */
  locator: StreamLocator | null;
  catchup: CatchupInfo | null;
  adult: boolean;
  xtream: { id: number; epgChannelId: string | null } | null;
  /** First time ZIPTV saw this channel in the source (null = present since the first sync). */
  addedAt: Date | null;
  epg: EpgLink | null;
}

export interface MovieEntry {
  key: string;
  position: number;
  name: string;
  year: number | null;
  groups: string[];
  poster: string | null;
  /** 0–10. */
  rating: number | null;
  genres: string[];
  durationSecs: number | null;
  plot: string | null;
  kind: StreamKind;
  locator: StreamLocator | null;
  adult: boolean;
  xtream: { id: number; ext: string } | null;
  addedAt: Date | null;
}

export interface SeriesEntry {
  key: string;
  position: number;
  name: string;
  year: number | null;
  groups: string[];
  cover: string | null;
  rating: number | null;
  genres: string[];
  plot: string | null;
  adult: boolean;
  xtream: { id: number } | null;
  addedAt: Date | null;
}

export interface EpisodeEntry {
  key: string;
  seriesKey: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  durationSecs: number | null;
  still: string | null;
  airDate: string | null;
  kind: StreamKind;
  locator: StreamLocator | null;
  xtream: { id: number; ext: string } | null;
}

export interface CatalogWarning {
  line: number;
  code: string;
  message: string;
}

/** Everything a provider adapter returns for one sync. */
export interface CatalogBuild {
  live: LiveChannelEntry[];
  movies: MovieEntry[];
  series: SeriesEntry[];
  episodes: EpisodeEntry[];
  /** XMLTV guide URLs announced by the source (`url-tvg`, Xtream `xmltv.php`). */
  epgUrls: string[];
  format: string;
  encoding: string;
  warnings: CatalogWarning[];
  warningCount: number;
  truncated: boolean;
  /** Xtream account details, when the provider reports them. */
  account: ProviderAccount | null;
  /** The M3U came from an Xtream panel (`get.php?username=…`). */
  xtreamCandidate: boolean;
}

export interface ProviderAccount {
  status: string;
  expiresAt: Date | null;
  maxConnections: number | null;
  activeConnections: number | null;
  trial: boolean;
}

export interface CatalogStats {
  live: number;
  movies: number;
  series: number;
  episodes: number;
  groups: number;
  unplayable: number;
  catchup: number;
  epgMapped: number;
}

export function computeStats(build: Pick<CatalogBuild, 'live' | 'movies' | 'series' | 'episodes'>): CatalogStats {
  const groups = new Set<string>();
  let unplayable = 0;
  let catchup = 0;
  let epgMapped = 0;
  for (const channel of build.live) {
    for (const group of channel.groups) groups.add(group);
    if (channel.unplayableReason) unplayable++;
    if (channel.catchup) catchup++;
    if (channel.epg) epgMapped++;
  }
  return {
    live: build.live.length,
    movies: build.movies.length,
    series: build.series.length,
    episodes: build.episodes.length,
    groups: groups.size,
    unplayable,
    catchup,
    epgMapped,
  };
}

export function isCatalogEmpty(build: Pick<CatalogBuild, 'live' | 'movies' | 'series'>): boolean {
  return build.live.length === 0 && build.movies.length === 0 && build.series.length === 0;
}
