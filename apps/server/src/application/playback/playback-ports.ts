import type { ContentRefDto, PlaybackContentDto, PlaybackEventRequest, PlaybackPlanDto } from '@ziptv/contracts';

import type { StreamKind, StreamLocator, UnplayableReason } from '../../domain/catalog/model.js';
import type { Viewer } from '../identity/viewer.js';
import type { SourceRecord } from '../ports/source-repository.js';

/** Where the stream of a resolved item is. */
export interface StreamTarget {
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  locator: StreamLocator | null;
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

/** Stream URLs of provider-API sources (Xtream) and catch-up URLs. */
export interface StreamUrlResolver {
  provider(source: SourceRecord, type: 'live' | 'movie' | 'episode', ref: { id: number; ext?: string }, kind: StreamKind): Promise<StreamTarget>;
  catchup?(viewer: Viewer, source: SourceRecord, ref: Extract<ContentRefDto, { type: 'catchup' }>): Promise<ResolvedContent>;
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
}

export const noopPlaybackObserver: PlaybackObserver = {
  onPlanIssued: async () => undefined,
  onEvent: async () => undefined,
  resumePosition: async () => null,
};
