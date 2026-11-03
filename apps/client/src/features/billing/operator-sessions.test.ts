import type { PlaybackPlanDto, PlaybackSessionDto, StartPlaybackSessionRequest } from '@ziptv/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { deviceName, DeviceRegistry } from './device';
import { OperatorPlaybackSessions, type PlaybackSessionApi } from './operator-sessions';

const plan = (id: string) => ({ sessionId: id, candidates: [] }) as unknown as PlaybackPlanDto;

/** A scripted server: records every call, answers starts in the order they are released. */
function fakeServer() {
  const calls: string[] = [];
  const starts: { body: StartPlaybackSessionRequest; resolve: (dto: PlaybackSessionDto) => void; reject: (error: unknown) => void }[] = [];
  let counter = 0;
  const api: PlaybackSessionApi = {
    startSession: (body) =>
      new Promise((resolve, reject) => {
        calls.push(`start ${body.channelId}${body.replaces ? ` replaces ${body.replaces}` : ''}`);
        starts.push({ body, resolve, reject });
      }),
    heartbeat: vi.fn(async (id: string) => void calls.push(`beat ${id}`)),
    stopSession: vi.fn(async (id: string) => void calls.push(`stop ${id}`)),
  };
  const answer = (index = starts.length - 1) => {
    const id = `ps${++counter}`;
    starts[index]!.resolve({ playbackSessionId: id, heartbeatIntervalSeconds: 30, expiresAt: '', policy: { access: 'package', maxStreams: 1, activeStreams: 1 }, plan: plan(id) });
    return id;
  };
  return { api, calls, starts, answer };
}

function timers() {
  const active = new Map<number, () => void>();
  let next = 0;
  return {
    active,
    fire: () => [...active.values()].forEach((handler) => handler()),
    impl: { setInterval: (handler: () => void) => (active.set(++next, handler), next), clearInterval: (handle: unknown) => void active.delete(handle as number) },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const server = fakeServer();
  const clock = timers();
  const register = vi.fn(async () => ({ id: 'dev1', name: 'Chrome', platform: 'web' as const, createdAt: '', lastSeenAt: '', current: true }));
  const sessions = new OperatorPlaybackSessions(server.api, new DeviceRegistry(register), () => 'token-a', clock.impl);
  return { ...server, clock, register, sessions };
}

describe('OperatorPlaybackSessions', () => {
  it('starts a session per viewing, replaces it on zap, beats while playing and stops on release', async () => {
    const { sessions, calls, answer, clock, register } = setup();
    const first = sessions.resolve('news', false, new AbortController().signal);
    await flush();
    const id = answer();
    await expect(first).resolves.toMatchObject({ sessionId: id });
    expect(clock.active.size).toBe(1);
    clock.fire();
    await flush();

    const second = sessions.resolve('sport', false, new AbortController().signal);
    await flush();
    answer();
    await second;
    expect(clock.active.size).toBe(1);
    sessions.release();
    await flush();
    expect(clock.active.size).toBe(0);
    expect(calls).toEqual(['start news', 'beat ps1', 'start sport replaces ps1', 'stop ps2']);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('serialises fast zapping and stops a session that arrives after the viewer moved on', async () => {
    const { sessions, calls, starts, answer } = setup();
    const zappedAway = new AbortController();
    const first = sessions.resolve('a', false, zappedAway.signal);
    const second = sessions.resolve('b', false, new AbortController().signal);
    await flush();
    expect(starts).toHaveLength(1); // b waits for a: never two starts in flight
    zappedAway.abort();
    answer(0);
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' });
    await flush();
    answer(1);
    await expect(second).resolves.toMatchObject({ sessionId: 'ps2' });
    // a was stopped as soon as it arrived; b did not "replace" it (it no longer existed).
    expect(calls).toEqual(['start a', 'stop ps1', 'start b']);
  });

  it('a refused heartbeat ends the viewing and tells the player; network trouble does not', async () => {
    const { sessions, api, answer, clock } = setup();
    const lost = vi.fn();
    sessions.onLost(lost);
    const playing = sessions.resolve('news', false, new AbortController().signal);
    await flush();
    answer();
    await playing;

    vi.mocked(api.heartbeat).mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'));
    clock.fire();
    await flush();
    expect(lost).not.toHaveBeenCalled();
    expect(sessions.sessionId).toBe('ps1');

    vi.mocked(api.heartbeat).mockRejectedValueOnce(new ApiError(403, 'NOT_ENTITLED', 'territory', { reason: 'territory' }));
    clock.fire();
    await flush();
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_ENTITLED' }));
    expect(sessions.sessionId).toBeNull();
    expect(clock.active.size).toBe(0);
  });

  it('registers the device again when it was removed from the account', async () => {
    const { sessions, starts, register } = setup();
    const playing = sessions.resolve('news', false, new AbortController().signal);
    await flush();
    starts[0]!.reject(new ApiError(403, 'DEVICE_REQUIRED', 'Register this device'));
    await flush();
    await flush();
    expect(register).toHaveBeenCalledTimes(2);
    starts[1]!.resolve({ playbackSessionId: 'ps9', heartbeatIntervalSeconds: 30, expiresAt: '', policy: { access: 'package', maxStreams: 1, activeStreams: 1 }, plan: plan('ps9') });
    await expect(playing).resolves.toMatchObject({ sessionId: 'ps9' });
  });

  it('a refused start (limit reached) clears the replaced viewing locally too', async () => {
    const { sessions, starts, answer, clock } = setup();
    const first = sessions.resolve('a', false, new AbortController().signal);
    await flush();
    answer();
    await first;
    const second = sessions.resolve('b', false, new AbortController().signal);
    await flush();
    starts[1]!.reject(new ApiError(409, 'CONCURRENCY_LIMIT', 'Too many'));
    await expect(second).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    expect(sessions.sessionId).toBeNull();
    expect(clock.active.size).toBe(0);
  });
});

describe('deviceName', () => {
  it('names the browser and the system', () => {
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(deviceName('curl/8')).toBe('Browser');
  });
});
