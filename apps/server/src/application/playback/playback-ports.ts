import type { TelemetrySubject } from '../ports/health.js';
import type { ContentRefDto, PlaybackContentDto, PlaybackEventRequest, PlaybackPlanDto } from '@ziptv/contracts';

import type { StreamKind, StreamLocator, UnplayableReason } from '../../domain/catalog/model.js';
import type { Viewer } from '../identity/viewer.js';
import type { SourceRecord } from '../ports/source-repository.js';

/** Where the stream of a resolved item is. */
export interface StreamTarget {
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  locator: StreamLocator | null;
  /** What client telemetry of this target is about (operator feed / BYO source). */
  telemetry?: TelemetrySubject;
  /** Quality limit (operator channels): HLS variants taller than this are left out by the proxy. */
  maxHeight?: number;
  /**
   * The limit is the licence's: a format whose quality cannot be limited (not HLS) is not offered.
   * A plan's own ceiling alone is applied where it can be and does not take other formats away.
   */
  strictCap?: boolean;
}

export interface ResolvedContent {
  content: PlaybackContentDto;
  target: StreamTarget;
  locked: boolean;
  /** Live channels: identity used to find the same channel in other sources. */
  nameKey: string | null;
  seriesTitle: string | null;
  next: PlaybackPlanDto['next'];
  episode?: { season: number; episode: number };
}

/** Stream URLs of provider-API sources (Xtream): live / VOD items and the live archive. */
export interface StreamUrlResolver {
  provider(source: SourceRecord, type: 'live' | 'movie' | 'episode', ref: { id: number; ext?: string }, kind: StreamKind): Promise<StreamTarget>;
  /** Archive of an Xtream live channel, [start, end) (panel time zone applied). */
  archive?(source: SourceRecord, ref: { id: number }, range: { start: Date; end: Date }): Promise<StreamTarget>;
}

export interface IssuedSession {
  sessionId: string;
  sourceName: string;
  content: PlaybackContentDto;
  seriesTitle: string | null;
  /** Provider image URL as stored (`content.image` may already be a proxy path). */
  rawImage: string | null;
  episode: { season: number; episode: number } | null;
}

/**
 * Watches playback for Continue Watching (progress), Watch History and stream health.
 * Implemented by the user-state module; the playback use case only reports what happens.
 */
export interface PlaybackObserver {
  onPlanIssued(viewer: Viewer, session: IssuedSession): Promise<void>;
  onEvent(viewer: Viewer, event: PlaybackEventRequest): Promise<void>;
  resumePosition(viewer: Viewer, ref: ContentRefDto): Promise<number | null>;
  /** True when `sessionId` is this profile's viewing of the same content (reconnects). */
  continues?(viewer: Viewer, sessionId: string, ref: ContentRefDto): Promise<boolean>;
  /** The BYO source a viewing of this profile plays from (provider connection tracking). */
  sourceOf?(viewer: Viewer, sessionId: string): Promise<string | null>;
}

export const noopPlaybackObserver: PlaybackObserver = {
  onPlanIssued: async () => undefined,
  onEvent: async () => undefined,
  resumePosition: async () => null,
};
