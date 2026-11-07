import type { ContentRefDto, PlaybackEventRequest } from '@ziptv/contracts';

import { decideProgress, MAX_HEARTBEAT_CREDIT_SECS, resumeFrom } from '../../domain/viewer/progress.js';
import type { Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { HistoryRepository, ProgressRepository } from '../ports/user-state-repository.js';
import type { IssuedSession, PlaybackObserver } from '../playback/playback-ports.js';
import { invalidateHome } from './cache-keys.js';

/** A reconnect within this long continues the same viewing. */
const CONTINUE_WINDOW_MS = 10 * 60_000;

/**
 * Turns playback into user state:
 *   plan issued → history row (id = playback session id, so any instance can update it)
 *   start / heartbeat / stop → watch time credited server-side (capped per beat); VOD position →
 *   progress (Continue Watching), with start/completion thresholds from the domain.
 * Events for a session of another profile are ignored (the row is not found for that profile).
 */
export class WatchObserver implements PlaybackObserver {
  constructor(
    private readonly deps: {
      history: HistoryRepository;
      progress: ProgressRepository;
      cache: Cache;
      clock: Clock;
      logger: Logger;
      /** Settings → Playback → Resume playback. */
      resumeEnabled: (viewer: Viewer) => Promise<boolean>;
    },
  ) {}

  async onPlanIssued(viewer: Viewer, session: IssuedSession): Promise<void> {
    const ref = session.content.ref;
    // Operator films have no history/progress store yet (Phase 17 opens the catalogue; their history comes later).
    if (ref.type === 'operator_vod') return;
    try {
      await this.deps.history.start(
        {
          id: session.sessionId,
          profileId: viewer.profileId,
          ...owner(ref),
          contentType: ref.type,
          seriesKey: ref.type === 'episode' ? ref.seriesKey : null,
          season: session.episode?.season ?? null,
          episode: session.episode?.episode ?? null,
          title: session.content.title,
          subtitle: session.content.subtitle,
          seriesTitle: session.seriesTitle,
          image: session.rawImage,
          programmeStart: archiveOf(ref)?.start ?? null,
          programmeEnd: archiveOf(ref)?.end ?? null,
        },
        this.deps.clock.now(),
      );
    } catch (error) {
      // History is best-effort: playback must never fail because of it.
      this.deps.logger.warn({ err: error, ...owner(ref) }, 'Recording a viewing failed');
    }
  }

  async onEvent(viewer: Viewer, event: PlaybackEventRequest): Promise<void> {
    // (operator channels are live: watch time only, no progress)
    if (event.type === 'error') return;
    const now = this.deps.clock.now();
    const row = await this.deps.history.touch(event.sessionId, viewer.profileId, now, event.type === 'start' ? 0 : MAX_HEARTBEAT_CREDIT_SECS);
    if (!row || !row.sourceId || (row.contentType !== 'movie' && row.contentType !== 'episode')) return;
    if (event.position === undefined || event.duration === undefined) return;

    const ref = { profileId: viewer.profileId, sourceId: row.sourceId, contentType: row.contentType, seriesKey: row.seriesKey ?? '', key: row.key };
    const existing = await this.deps.progress.find(ref);
    const decision = decideProgress(event.position, event.duration, existing !== null);
    if (decision.action === 'skip') return;
    await this.deps.progress.save(
      {
        ...ref,
        season: row.season,
        episode: row.episode,
        title: row.title,
        seriesTitle: row.seriesTitle,
        image: row.image,
        position: decision.position,
        duration: decision.duration,
        completed: decision.completed,
      },
      now,
    );
    if (!existing || existing.completed !== decision.completed || event.type === 'stop') invalidateHome(this.deps.cache, viewer.profileId);
  }

  async continues(viewer: Viewer, sessionId: string, ref: ContentRefDto): Promise<boolean> {
    if (ref.type === 'operator_vod') return false;
    const row = await this.deps.history.find(sessionId, viewer.profileId);
    const expected = owner(ref);
    if (!row || row.sourceId !== expected.sourceId || row.channelId !== expected.channelId || row.contentType !== ref.type || row.key !== expected.key) return false;
    if (ref.type === 'episode' && row.seriesKey !== ref.seriesKey) return false;
    // Live vs. archive, and which programme, must match too.
    if ((row.programmeStart?.getTime() ?? null) !== (archiveOf(ref)?.start.getTime() ?? null)) return false;
    // Only a recent viewing is continued (a reconnect, not a replay hours later).
    return this.deps.clock.now().getTime() - row.watchedAt.getTime() < CONTINUE_WINDOW_MS;
  }

  async sourceOf(viewer: Viewer, sessionId: string): Promise<string | null> {
    return (await this.deps.history.find(sessionId, viewer.profileId))?.sourceId ?? null;
  }

  async resumePosition(viewer: Viewer, ref: ContentRefDto): Promise<number | null> {
    if (ref.type !== 'movie' && ref.type !== 'episode') return null;
    if (!(await this.deps.resumeEnabled(viewer))) return null;
    const progress = await this.deps.progress.find({
      profileId: viewer.profileId,
      sourceId: ref.sourceId,
      contentType: ref.type,
      seriesKey: ref.type === 'episode' ? ref.seriesKey : '',
      key: ref.key,
    });
    return resumeFrom(progress);
  }
}

/** History owner of a content reference: a user source item, or an operator channel. */
function owner(ref: Exclude<ContentRefDto, { type: 'operator_vod' }>): { sourceId: string | null; channelId: string | null; key: string } {
  return ref.type === 'operator' ? { sourceId: null, channelId: ref.channelId, key: ref.channelId } : { sourceId: ref.sourceId, channelId: null, key: ref.key };
}

/** The programme a catch-up viewing replays (BYO archive or operator archive); null = live / VOD. */
function archiveOf(ref: ContentRefDto): { start: Date; end: Date } | null {
  if (ref.type === 'catchup') return { start: new Date(ref.start), end: new Date(ref.end) };
  if (ref.type === 'operator' && ref.start && ref.end) return { start: new Date(ref.start), end: new Date(ref.end) };
  return null;
}
