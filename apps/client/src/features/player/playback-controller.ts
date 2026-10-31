import type { AlternateStreamDto, PlaybackCandidateDto, PlaybackPlanDto, ProblemKind } from '@ziptv/contracts';

import { resolveApiUrl } from '../../config';
import { ApiError, errorMessage } from '../../lib/api-client';
import { problemOf } from '../../lib/problems';
import { loadEngine as defaultLoadEngine, type EngineLoader } from './engines';
import { EngineError, NO_TRACKS, preferredTrack, type EngineHandle, type QualityLevel, type TrackState } from './engines/types';

export type PlaybackStatus = 'idle' | 'resolving' | 'connecting' | 'playing' | 'buffering' | 'paused' | 'reconnecting' | 'blocked' | 'ended' | 'error';

export interface PlaybackAttempt {
  index: number;
  total: number;
  engine: PlaybackCandidateDto['engine'];
  via: PlaybackCandidateDto['via'];
}

export interface PlaybackFailure {
  /** Which error screen to show (stream unavailable, unsupported format, locked…). */
  problem: ProblemKind;
  message: string;
  /** One line per failed candidate — shown under "technical details". */
  details: string[];
  /** Web-page entries (YouTube…) can be opened externally. */
  externalUrl?: string;
  retryable: boolean;
  /** "Try alternate stream": the same channel in other sources. */
  alternates: AlternateStreamDto[];
}

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  attempt: PlaybackAttempt | null;
  failure: PlaybackFailure | null;
  qualities: QualityLevel[];
  quality: number;
  /** Autoplay with sound was blocked; playback started muted. */
  mutedByAutoplayPolicy: boolean;
  /** The plan being played (content info, resume position, next episode, alternates). */
  plan: PlaybackPlanDto | null;
  tracks: TrackState;
}

/** Settings → Playback, applied when a stream starts. */
export interface PlaybackPreferences {
  /** '' = stream default. */
  audio: string;
  /** '' = stream default, 'off' = none. */
  subtitles: string;
  quality: 'auto' | 'highest' | 'lowest' | '1080' | '720' | '480';
  /** Start VOD at the saved position. */
  resume: boolean;
  /** Off: the stream is prepared but waits for Play. */
  autoplay: boolean;
}

const DEFAULT_PREFERENCES: PlaybackPreferences = { audio: '', subtitles: '', quality: 'auto', resume: true, autoplay: true };

export const IDLE_SNAPSHOT: PlaybackSnapshot = {
  status: 'idle',
  attempt: null,
  failure: null,
  qualities: [],
  quality: -1,
  mutedByAutoplayPolicy: false,
  plan: null,
  tracks: NO_TRACKS,
};

/** `continueSession`: a reconnect of the current viewing (keeps one history entry). */
export type PlanResolver = (signal: AbortSignal, context: { continueSession?: string }) => Promise<PlaybackPlanDto>;

interface ControllerOptions {
  loadEngine?: EngineLoader;
  startupTimeoutMs?: number;
  /** Stalled (no progress while not paused) longer than this → reconnect. */
  stallTimeoutMs?: number;
  maxReconnects?: number;
}

/**
 * Framework-agnostic playback state machine bound to one <video> element.
 *
 *   play(resolver) → resolve plan → try candidates in order → playing
 *                                   ↳ every failure: next candidate; all failed: error
 *   runtime fatal / stall → reconnect with backoff (fresh plan = fresh proxy tokens)
 *
 * Every play() starts a new "generation"; results of an older generation are dropped, so
 * fast channel zapping can never attach a stale stream.
 */
export class PlaybackController {
  private readonly loadEngine: EngineLoader;
  private readonly startupTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxReconnects: number;

  private snapshot: PlaybackSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private engine: EngineHandle | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private resolver: PlanResolver | null = null;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = { time: -1, at: 0 };
  private preferences: PlaybackPreferences = DEFAULT_PREFERENCES;
  /** VOD: where to continue after a reconnect (the fresh stream starts at 0). */
  private continueAt: number | null = null;
  private tracksApplied = false;
  private readonly detachVideoListeners: () => void;

  constructor(
    private readonly video: HTMLVideoElement,
    options: ControllerOptions = {},
  ) {
    this.loadEngine = options.loadEngine ?? defaultLoadEngine;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 25_000;
    this.maxReconnects = options.maxReconnects ?? 4;
    this.detachVideoListeners = this.attachVideoListeners();
  }

  // --- useSyncExternalStore contract -------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  // --- commands --------------------------------------------------------------------------------
  play(resolver: PlanResolver): void {
    this.resolver = resolver;
    this.reconnects = 0;
    void this.start('resolving');
  }

  /** Manual retry from the error screen. */
  retry(): void {
    if (!this.resolver) return;
    this.reconnects = 0;
    void this.start('resolving');
  }

  stop(): void {
    this.generation++;
    this.resolver = null;
    this.cancelPending();
    this.teardownEngine();
    this.setSnapshot(IDLE_SNAPSHOT);
  }

  setPreferences(preferences: PlaybackPreferences): void {
    this.preferences = preferences;
  }

  setAudioTrack(index: number): void {
    this.engine?.setAudioTrack?.(index);
    this.refreshTracks();
  }

  setSubtitleTrack(index: number): void {
    this.engine?.setSubtitleTrack?.(index);
    this.refreshTracks();
  }

  /** VOD seeking (seconds); clamped to the media. */
  seekTo(seconds: number): void {
    const duration = this.video.duration;
    if (!Number.isFinite(duration)) return;
    this.video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.5));
  }

  seekBy(delta: number): void {
    this.seekTo(this.video.currentTime + delta);
  }

  setQuality(index: number): void {
    this.engine?.setQuality(index);
    this.update({ quality: index });
  }

  goLive(): void {
    this.engine?.goLive();
    if (this.video.paused) void this.video.play().catch(() => undefined);
  }

  destroy(): void {
    this.stop();
    this.detachVideoListeners();
    this.listeners.clear();
  }

  // --- internals -----------------------------------------------------------------------------
  private async start(status: 'resolving' | 'reconnecting'): Promise<void> {
    const generation = ++this.generation;
    this.cancelPending();
    this.teardownEngine();
    this.abort = new AbortController();
    if (status === 'resolving') this.continueAt = null;
    this.tracksApplied = false;
    this.update({ status, attempt: null, failure: null, qualities: [], quality: -1, tracks: NO_TRACKS, ...(status === 'resolving' ? { plan: null } : {}) });

    let plan: PlaybackPlanDto;
    try {
      const previous = status === 'reconnecting' ? this.snapshot.plan?.sessionId : undefined;
      plan = await this.resolver!(this.abort.signal, previous ? { continueSession: previous } : {});
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ApiError && error.code === 'ABORTED') return;
      this.fail(planFailure(error));
      return;
    }
    if (generation !== this.generation) return;
    this.update({ plan });

    const details: string[] = [];
    const kinds = new Set<string>();
    for (const [index, candidate] of plan.candidates.entries()) {
      this.update({ status: status === 'reconnecting' ? 'reconnecting' : 'connecting', attempt: { index, total: plan.candidates.length, engine: candidate.engine, via: candidate.via } });
      try {
        const factory = await this.loadEngine(candidate.engine);
        if (generation !== this.generation) return;
        const engine = factory(this.video, resolveApiUrl(candidate.url));
        this.engine = engine;
        await withTimeout(engine.ready, this.startupTimeoutMs);
        if (generation !== this.generation) return;

        engine.onFatal((error) => this.onRuntimeFailure(generation, error));
        engine.onTracksChanged?.(() => generation === this.generation && this.refreshTracks());
        this.applyQualityPreference(engine);
        this.update({ qualities: engine.qualityLevels(), quality: engine.currentQuality() });
        this.refreshTracks();
        this.seekToStart(plan);
        await this.startPlayback(generation);
        this.startStallWatchdog(generation);
        return;
      } catch (error) {
        if (generation !== this.generation) return;
        details.push(`${candidate.engine} · ${candidate.via}: ${errorMessage(error)}`);
        kinds.add(error instanceof EngineError ? error.kind : 'other');
        this.teardownEngine();
      }
    }

    const codecOnly = [...kinds].every((kind) => kind === 'unsupported' || kind === 'media');
    this.fail({
      problem: codecOnly ? 'unsupported_format' : 'stream_unavailable',
      message: codecOnly
        ? 'This browser cannot decode this stream (unsupported format or codec). Try another browser or device.'
        : "ZIPTV couldn't connect to this stream.",
      details,
      retryable: true,
      alternates: plan.alternates,
    });
  }

  private async startPlayback(generation: number): Promise<void> {
    // Autoplay off applies to the first start only; reconnects continue playing.
    if (!this.preferences.autoplay && this.snapshot.status === 'connecting') {
      this.update({ status: 'paused' });
      return;
    }
    try {
      await this.video.play();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        // Autoplay with sound is blocked until the user interacts — start muted instead.
        this.video.muted = true;
        try {
          await this.video.play();
          this.update({ mutedByAutoplayPolicy: true });
        } catch {
          this.update({ status: 'blocked' });
        }
        return;
      }
      if (error instanceof DOMException && error.name === 'AbortError') return; // superseded
      throw error;
    }
  }

  private onRuntimeFailure(generation: number, error: EngineError | Error): void {
    if (generation !== this.generation) return;
    if (this.reconnects >= this.maxReconnects) {
      this.fail({
        problem: 'stream_unavailable',
        message: 'The stream stopped and could not be resumed.',
        details: [errorMessage(error)],
        retryable: true,
        alternates: this.snapshot.plan?.alternates ?? [],
      });
      return;
    }
    const delay = Math.min(8_000, 1_000 * 2 ** this.reconnects);
    this.reconnects++;
    if (this.snapshot.plan && this.snapshot.plan.content.mode !== 'live' && this.video.currentTime > 0) this.continueAt = this.video.currentTime;
    this.teardownEngine();
    this.update({ status: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => void this.start('reconnecting'), delay);
  }

  private startStallWatchdog(generation: number): void {
    this.lastProgress = { time: this.video.currentTime, at: Date.now() };
    this.stallTimer = setInterval(() => {
      if (generation !== this.generation || this.video.paused) {
        this.lastProgress.at = Date.now();
        return;
      }
      if (this.video.currentTime !== this.lastProgress.time) {
        this.lastProgress = { time: this.video.currentTime, at: Date.now() };
        if (this.snapshot.status === 'playing') this.reconnects = 0; // healthy again
        return;
      }
      if (Date.now() - this.lastProgress.at > this.stallTimeoutMs) {
        this.onRuntimeFailure(generation, new Error('The stream stalled.'));
      }
    }, 2_000);
  }

  private attachVideoListeners(): () => void {
    const on = (event: string, handler: () => void) => {
      this.video.addEventListener(event, handler);
      return () => this.video.removeEventListener(event, handler);
    };
    const offs = [
      on('playing', () => this.engine && this.update({ status: 'playing' })),
      on('waiting', () => this.engine && this.snapshot.status === 'playing' && this.update({ status: 'buffering' })),
      on('pause', () => this.engine && this.snapshot.status !== 'error' && this.update({ status: 'paused' })),
      on('volumechange', () => !this.video.muted && this.snapshot.mutedByAutoplayPolicy && this.update({ mutedByAutoplayPolicy: false })),
      on('ended', () => {
        if (!this.engine) return;
        // Live streams "end" when the upstream closes the connection: reconnect.
        if (!Number.isFinite(this.video.duration) || this.snapshot.plan?.content.mode === 'live') {
          this.onRuntimeFailure(this.generation, new Error('The live stream ended unexpectedly.'));
          return;
        }
        this.stopStallWatchdog();
        this.update({ status: 'ended' });
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  /** VOD: continue where a reconnect interrupted, else the saved resume position. */
  private seekToStart(plan: PlaybackPlanDto): void {
    if (plan.content.mode === 'live') return;
    const target = this.continueAt ?? (this.preferences.resume ? plan.resumeFrom : null);
    if (target && target > 0) {
      try {
        this.video.currentTime = target;
      } catch {
        /* not seekable yet: start from the beginning */
      }
    }
  }

  private applyQualityPreference(engine: EngineHandle): void {
    const levels = engine.qualityLevels().filter((level) => level.index >= 0);
    const wanted = this.preferences.quality;
    if (levels.length === 0 || wanted === 'auto') return;
    const pick = wanted === 'highest' ? levels[0] : wanted === 'lowest' ? levels.at(-1) : (levels.find((level) => level.label.startsWith(wanted)) ?? levels.find((level) => Number.parseInt(level.label, 10) <= Number(wanted)));
    if (pick) engine.setQuality(pick.index);
  }

  private refreshTracks(): void {
    const engine = this.engine;
    if (!engine?.tracks) return;
    let tracks = engine.tracks();
    // Language preferences apply once per stream, as soon as the tracks are known.
    if (!this.tracksApplied && (tracks.audio.length > 0 || tracks.subtitles.length > 0)) {
      this.tracksApplied = true;
      const audio = preferredTrack(tracks.audio, this.preferences.audio);
      if (audio !== null && audio >= 0 && audio !== tracks.audioIndex) engine.setAudioTrack?.(audio);
      const subtitles = tracks.subtitles.length > 0 ? preferredTrack(tracks.subtitles, this.preferences.subtitles) : null;
      if (subtitles !== null && subtitles !== tracks.subtitleIndex) engine.setSubtitleTrack?.(subtitles);
      tracks = engine.tracks();
    }
    this.update({ tracks });
  }

  private fail(failure: PlaybackFailure): void {
    this.cancelPending();
    this.teardownEngine();
    this.update({ status: 'error', failure, attempt: null });
  }

  private cancelPending(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private teardownEngine(): void {
    const engine = this.engine;
    this.engine = null;
    if (!engine) return;
    engine.ready.catch(() => undefined); // a late startup rejection is irrelevant now
    try {
      engine.destroy();
    } catch {
      /* ignore */
    }
  }

  private update(patch: Partial<PlaybackSnapshot>): void {
    this.setSnapshot({ ...this.snapshot, ...patch });
  }

  private setSnapshot(snapshot: PlaybackSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

function planFailure(error: unknown): PlaybackFailure {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { url?: unknown; reason?: unknown };
    return {
      problem: problemOf(error),
      message: error.message,
      details: error.requestId ? [`request ${error.requestId}`] : [],
      externalUrl: typeof details.url === 'string' ? details.url : undefined,
      retryable: error.code !== 'UNPLAYABLE' && error.code !== 'NOT_FOUND' && error.code !== 'PARENTAL_LOCKED',
      alternates: [],
    };
  }
  return { problem: 'stream_unavailable', message: errorMessage(error), details: [], retryable: true, alternates: [] };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the stream to start.')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
