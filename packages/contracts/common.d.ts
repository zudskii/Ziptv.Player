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
  // Sources
  | 'SOURCE_LIMIT_REACHED'
  | 'SOURCE_INVALID'
  | 'SOURCE_EMPTY'
  | 'SOURCE_NOT_SYNCABLE'
  | 'SOURCE_AUTH_FAILED'
  | 'SOURCE_EXPIRED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_BUSY'
  // EPG
  | 'EPG_UNAVAILABLE'
  | 'EPG_INVALID'
  // Playback
  | 'UNPLAYABLE'
  | 'UNSUPPORTED_FORMAT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_BLOCKED'
  // Profiles / parental controls
  | 'PROFILE_LIMIT_REACHED'
  | 'PARENTAL_LOCKED'
  | 'PIN_REQUIRED'
  | 'PIN_INVALID'
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

/**
 * User-facing problem categories. Every failure the UI can show maps to one of these, and each
 * has its own screen (title, explanation, actions) — never a bare "Error 502".
 */
export type ProblemKind =
  | 'stream_unavailable'
  | 'playlist_expired'
  | 'auth_failed'
  | 'source_unavailable'
  | 'epg_unavailable'
  | 'unsupported_format'
  | 'parental_locked';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Cursor pagination: pass `nextCursor` back as `cursor` until it is null. */
export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
  /** Total matching items when cheap to compute; omitted otherwise. */
  total?: number;
}

export type StreamKind = 'hls' | 'dash' | 'mpegts' | 'flv' | 'progressive' | 'unknown';

/**
 * unsupported_protocol — rtmp/rtsp/udp/... (needs a transcoder, browsers can't play it)
 * drm                  — Widevine/PlayReady protected (license server required)
 * web_page             — link to a website (YouTube, Twitch, ...), not a media stream
 */
export type UnplayableReason = 'unsupported_protocol' | 'drm' | 'web_page';

export type HealthState = 'online' | 'slow' | 'unstable' | 'offline' | 'unknown';

export interface ParseWarningDto {
  /** 1-based line number in the source playlist (0 when not tied to a line). */
  line: number;
  code: string;
  message: string;
}
