/**
 * ZIPTV HTTP API contract (v1).
 *
 * Single source of truth for request/response shapes shared by the server and the client.
 * This package is intentionally types-only (a .d.ts file): it is erased at build time,
 * so neither app pays a runtime cost and no build step is needed.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'PLAYLIST_EMPTY'
  | 'PLAYLIST_INVALID'
  | 'PLAYLIST_LIMIT_REACHED'
  | 'PLAYLIST_NOT_REFRESHABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_BLOCKED'
  | 'UNPLAYABLE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

// ---------------------------------------------------------------------------
// Session (anonymous device identity)
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  /** Secret id from the pre-2.0 client (`persist:root` in localStorage). One-time exchange. */
  legacySecretId?: string;
}

export interface SessionDto {
  /** Opaque bearer token. Send as `Authorization: Bearer <token>`. */
  token: string;
  userId: string;
  migratedFromLegacy: boolean;
}

export interface MeDto {
  userId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export type PlaylistSourceDto =
  | { type: 'file'; fileName: string }
  | { type: 'url'; url: string };

export interface ParseWarningDto {
  /** 1-based line number in the source playlist (0 when not tied to a line). */
  line: number;
  code: string;
  message: string;
}

export interface PlaylistStatsDto {
  channels: number;
  groups: number;
  unplayable: number;
}

export interface PlaylistDto {
  id: string;
  name: string;
  source: PlaylistSourceDto;
  /** Increments on every successful (re)import. Use it as a cache key for the channel list. */
  revision: number;
  stats: PlaylistStatsDto;
  epgUrls: string[];
  /** First N parser warnings of the latest import. */
  warnings: ParseWarningDto[];
  warningCount: number;
  createdAt: string;
  updatedAt: string;
  refreshedAt: string;
}

export interface ImportPlaylistRequest {
  url: string;
  name?: string;
}

export interface RenamePlaylistRequest {
  name: string;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type StreamKind = 'hls' | 'dash' | 'mpegts' | 'flv' | 'progressive' | 'unknown';

/**
 * unsupported_protocol — rtmp/rtsp/udp/... (needs a transcoder, browsers can't play it)
 * drm                  — Widevine/PlayReady protected (license server required)
 * web_page             — link to a website (YouTube, Twitch, ...), not a media stream
 */
export type UnplayableReason = 'unsupported_protocol' | 'drm' | 'web_page';

export interface ChannelDto {
  /** Stable across refreshes as long as tvg-id/name/group don't change. URL-safe. */
  key: string;
  name: string;
  /**
   * Group labels as found in the playlist (`group-title`, `#EXTGRP`). Empty when the entry has
   * no group. `;`-separated multi-groups (`Family;Movies`) are split, as Kodi/iptv-org do.
   */
  groups: string[];
  logo: string | null;
  tvgId: string | null;
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
}

export interface ChannelListDto {
  playlistId: string;
  revision: number;
  channels: ChannelDto[];
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type PlaybackEngineName = 'hls' | 'mpegts' | 'flv' | 'native' | 'dash';

export interface PlaybackCandidateDto {
  engine: PlaybackEngineName;
  /** Absolute upstream URL (direct) or API-relative path (proxy), resolve against the API origin. */
  url: string;
  via: 'direct' | 'proxy';
}

export interface ResolvePlaybackRequest {
  playlistId: string;
  channelKey: string;
  /** Page served over https — decides whether plain-http streams can be played directly. */
  secureContext: boolean;
}

export interface PlaybackPlanDto {
  channel: ChannelDto;
  /** Ordered: the client tries each candidate until one starts playing. */
  candidates: PlaybackCandidateDto[];
  /** Proxy URLs stop working after this instant; request a new plan. */
  expiresAt: string;
}
