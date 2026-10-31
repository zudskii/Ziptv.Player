import type { ChannelDto } from './catalog';
import type { ProgrammeDto } from './epg';

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** What to play. Keys are the stable catalog keys (they survive source syncs). */
export type ContentRefDto =
  | { type: 'channel'; sourceId: string; key: string }
  | { type: 'movie'; sourceId: string; key: string }
  | { type: 'episode'; sourceId: string; seriesKey: string; key: string }
  /** A past programme from the channel archive; `start`/`end` are ISO instants. */
  | { type: 'catchup'; sourceId: string; key: string; start: string; end: string };

export type PlaybackEngineName = 'hls' | 'mpegts' | 'flv' | 'native' | 'dash';

export interface PlaybackCandidateDto {
  engine: PlaybackEngineName;
  /** Absolute upstream URL (direct) or API-relative path (proxy), resolve against the API origin. */
  url: string;
  via: 'direct' | 'proxy';
}

export interface ResolvePlaybackRequest {
  content: ContentRefDto;
  /** Page served over https — decides whether plain-http streams can be played directly. */
  secureContext: boolean;
  /** Parental unlock token, required for locked content. */
  unlockToken?: string;
  /**
   * Reconnect of the same viewing: the previous plan's `sessionId`. When it belongs to this
   * profile and the same content, the new plan keeps it (one history entry per viewing).
   */
  continueSession?: string;
}

export interface PlaybackContentDto {
  ref: ContentRefDto;
  mode: 'live' | 'vod' | 'catchup';
  title: string;
  /** Series name + episode label, programme title, group… */
  subtitle: string | null;
  image: string | null;
  /** VOD/catch-up duration when known. */
  durationSecs: number | null;
  /** Live channel / catch-up channel. */
  channel: ChannelDto | null;
  /** Catch-up: the programme being replayed. */
  programme: ProgrammeDto | null;
}

/** "Try alternate stream": the same channel in another source. */
export interface AlternateStreamDto {
  ref: ContentRefDto;
  sourceName: string;
  name: string;
}

export interface PlaybackPlanDto {
  /** Identifies this viewing for progress/heartbeat events. */
  sessionId: string;
  content: PlaybackContentDto;
  /** Ordered: the client tries each candidate until one starts playing. */
  candidates: PlaybackCandidateDto[];
  /** Proxy URLs stop working after this instant; request a new plan. */
  expiresAt: string;
  /** Seconds to resume VOD from (null = from the start). */
  resumeFrom: number | null;
  /** Next episode (series) — drives "Next episode" and autoplay. */
  next: { ref: ContentRefDto; title: string; subtitle: string | null } | null;
  alternates: AlternateStreamDto[];
}

export type PlaybackEventType = 'start' | 'heartbeat' | 'stop' | 'error';

export interface PlaybackEventRequest {
  sessionId: string;
  type: PlaybackEventType;
  /** Seconds. */
  position?: number;
  duration?: number;
  /** For `error`: what failed (stream health telemetry). */
  error?: { kind: string; message: string };
  /** For `start`: how the stream was reached (stream health telemetry). */
  via?: 'direct' | 'proxy';
  /** For `start`: time to first frame. */
  startupMs?: number;
}
