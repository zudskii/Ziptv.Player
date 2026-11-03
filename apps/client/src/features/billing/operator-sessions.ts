import type { PlaybackPlanDto, PlaybackSessionDto, StartPlaybackSessionRequest } from '@ziptv/contracts';

import { ApiError } from '../../lib/api-client';
import { isDeviceRequired, type DeviceRegistry } from './device';

export interface PlaybackSessionApi {
  startSession(body: StartPlaybackSessionRequest): Promise<PlaybackSessionDto>;
  heartbeat(id: string): Promise<unknown>;
  stopSession(id: string, keepalive?: boolean): Promise<void>;
}

interface Timers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTimers: Timers = { setInterval: (handler, ms) => setInterval(handler, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>) };
const aborted = () => new ApiError(0, 'ABORTED', 'Request was cancelled.');
const noop = () => undefined;

/**
 * The client half of operator playback authorization: one server-side playback session per
 * viewing, kept alive by heartbeats and ended when the viewer stops, zaps away or closes the tab.
 *
 * Starts are serialised: zapping quickly must never leave an earlier session holding the
 * account's stream slot (the next start would then hit the concurrency limit against itself).
 * A start whose result arrives after the viewer moved on is stopped right away.
 */
export class OperatorPlaybackSessions {
  private current: { id: string; timer: unknown } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lostListener: ((error: ApiError) => void) | null = null;
  private disposed = false;

  constructor(
    private readonly api: PlaybackSessionApi,
    private readonly devices: DeviceRegistry,
    private readonly identity: () => string,
    private readonly timers: Timers = browserTimers,
  ) {}

  /** The server ended the viewing (entitlement, country, device, another device took the slot). */
  onLost(listener: (error: ApiError) => void): void {
    this.lostListener = listener;
  }

  /** Authorizes a viewing of `channelId` and returns its plan (links bound to the session). */
  resolve(channelId: string, secureContext: boolean, signal: AbortSignal, continueSession?: string): Promise<PlaybackPlanDto> {
    const run = this.chain.then(() => this.start(channelId, secureContext, signal, continueSession));
    this.chain = run.catch(noop);
    return run;
  }

  /** Ends the current viewing (stop, other content, page closing). */
  release(keepalive = false): void {
    const current = this.current;
    if (!current) return;
    this.clear();
    void this.api.stopSession(current.id, keepalive).catch(noop);
  }

  dispose(): void {
    this.release(true);
    this.disposed = true;
    this.lostListener = null;
  }

  get sessionId(): string | null {
    return this.current?.id ?? null;
  }

  private async start(channelId: string, secureContext: boolean, signal: AbortSignal, continueSession: string | undefined): Promise<PlaybackPlanDto> {
    if (signal.aborted || this.disposed) throw aborted();
    const identity = this.identity();
    // Not passing `signal` to the request: an aborted POST may still have created a session on
    // the server, and only its id lets us end it. The result is checked against `signal` instead.
    const attempt = async (deviceId: string) => this.api.startSession({ channelId, deviceId, secureContext, ...(this.current ? { replaces: this.current.id } : {}), ...(continueSession ? { continueSession } : {}) });
    let session: PlaybackSessionDto;
    try {
      try {
        session = await attempt(await this.devices.ensure(identity));
      } catch (error) {
        if (!isDeviceRequired(error)) throw error;
        // The device was removed from the account (on another screen): register this browser again.
        this.devices.forget();
        session = await attempt(await this.devices.ensure(identity));
      }
    } catch (error) {
      // The server ended the replaced session before refusing; locally it is gone too.
      this.release();
      throw error;
    }
    this.clear(); // replaced on the server
    if (signal.aborted || this.disposed) {
      void this.api.stopSession(session.playbackSessionId).catch(noop);
      throw aborted();
    }
    const id = session.playbackSessionId;
    const timer = this.timers.setInterval(() => void this.beat(id), Math.max(5, session.heartbeatIntervalSeconds) * 1000);
    this.current = { id, timer };
    return session.plan;
  }

  private async beat(id: string): Promise<void> {
    try {
      await this.api.heartbeat(id);
    } catch (error) {
      if (this.current?.id !== id) return;
      // Network trouble: the lease outlives a few missed beats. A definite "no" ends the viewing.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 409)) {
        this.clear();
        this.lostListener?.(error);
      }
    }
  }

  private clear(): void {
    if (this.current) this.timers.clearInterval(this.current.timer);
    this.current = null;
  }
}
