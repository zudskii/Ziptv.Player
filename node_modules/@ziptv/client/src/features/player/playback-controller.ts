import type { AlternateStreamDto, PlaybackCandidateDto, PlaybackPlanDto, ProblemKind } from '@ziptv/contracts';

import { resolveApiUrl } from '../../config';
import { ApiError, errorMessage } from '../../lib/api-client';
import { problemOf } from '../../lib/problems';
import { loadEngine as defaultLoadEngine, type EngineLoader } from './engines';
import { EngineError, type EngineHandle, type QualityLevel } from './engines/types';

export type PlaybackStatus = 'idle' | 'resolving' | 'connecting' | 'playing' | 'buffering' | 'paused' | 'reconnecting' | 'blocked' | 'error';

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
}

export const IDLE_SNAPSHOT: PlaybackSnapshot = {
  status: 'idle',
  attempt: null,
  failure: null,
  qualities: [],
  quality: -1,
  mutedByAutoplayPolicy: false,
  plan: null,
};

export type PlanResolver = (signal: AbortSignal) => Promise<PlaybackPlanDto>;

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
    this.update({ status, attempt: null, failure: null, qualities: [], quality: -1, ...(status === 'resolving' ? { plan: null } : {}) });

    let plan: PlaybackPlanDto;
    try {
      plan = await this.resolver!(this.abort.signal);
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
        this.update({ qualities: engine.qualityLevels(), quality: engine.currentQuality() });
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
        // Live streams "end" when the upstream closes the connection: reconnect.
        if (this.engine && !Number.isFinite(this.video.duration)) this.onRuntimeFailure(this.generation, new Error('The live stream ended unexpectedly.'));
      }),
    ];
    return () => offs.forEach((off) => off());
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
