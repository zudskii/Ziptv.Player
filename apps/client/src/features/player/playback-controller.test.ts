import type { PlaybackEngineName, PlaybackPlanDto } from '@ziptv/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { EngineError, type EngineFactory, type EngineHandle } from './engines/types';
import { PlaybackController, type PlaybackSnapshot } from './playback-controller';

/** Just enough of HTMLVideoElement for the controller. */
class FakeVideo extends EventTarget {
  paused = true;
  muted = false;
  currentTime = 0;
  duration = Number.POSITIVE_INFINITY;
  blockUnmutedAutoplay = false;

  async play(): Promise<void> {
    if (this.blockUnmutedAutoplay && !this.muted) throw new DOMException('blocked', 'NotAllowedError');
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  }
}

type Behaviour = 'ok' | 'fail' | 'hang';

interface FakeEngine extends EngineHandle {
  url: string;
  destroyed: boolean;
  fatal(error: EngineError): void;
}

function fakeLoader(behaviours: Behaviour[]) {
  const engines: FakeEngine[] = [];
  const loader = async (_name: PlaybackEngineName): Promise<EngineFactory> => (_video, url) => {
    const behaviour = behaviours[engines.length] ?? 'ok';
    let fatalListener: (error: EngineError) => void = () => undefined;
    const engine: FakeEngine = {
      url,
      destroyed: false,
      ready:
        behaviour === 'ok'
          ? Promise.resolve()
          : behaviour === 'fail'
            ? Promise.reject(new EngineError(`failed ${url}`, 'network', 403))
            : new Promise(() => undefined),
      onFatal: (listener) => {
        fatalListener = listener;
      },
      fatal: (error) => fatalListener(error),
      qualityLevels: () => [],
      currentQuality: () => -1,
      setQuality: () => undefined,
      goLive: () => undefined,
      destroy: () => {
        engine.destroyed = true;
      },
    };
    engines.push(engine);
    return engine;
  };
  return { loader, engines };
}

const plan = (...urls: string[]): PlaybackPlanDto => ({
  channel: { key: 'k', name: 'Ch', groups: [], logo: null, tvgId: null, kind: 'hls', unplayableReason: null },
  candidates: urls.map((url, index) => ({ engine: 'hls', url, via: index === 0 ? 'direct' : 'proxy' })),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('PlaybackController', () => {
  let video: FakeVideo;
  beforeEach(() => {
    video = new FakeVideo();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const create = (behaviours: Behaviour[], options = {}) => {
    const { loader, engines } = fakeLoader(behaviours);
    const controller = new PlaybackController(video as unknown as HTMLVideoElement, { loadEngine: loader, ...options });
    return { controller, engines };
  };

  it('falls back to the next candidate when the first cannot start', async () => {
    const { controller, engines } = create(['fail', 'ok']);
    controller.play(async () => plan('http://direct/a.m3u8', '/api/v1/media/stream/t1'));
    await settle();

    expect(engines.map((e) => [e.url, e.destroyed])).toEqual([
      ['http://direct/a.m3u8', true],
      ['/api/v1/media/stream/t1', false],
    ]);
    expect(controller.getSnapshot()).toMatchObject({ status: 'playing', attempt: { index: 1, via: 'proxy' } });
  });

  it('reports every failed candidate when nothing plays', async () => {
    const { controller } = create(['fail', 'fail']);
    controller.play(async () => plan('http://a', 'http://b'));
    await settle();
    const snapshot: PlaybackSnapshot = controller.getSnapshot();
    expect(snapshot.status).toBe('error');
    expect(snapshot.failure?.details).toEqual(['hls · direct: failed http://a', 'hls · proxy: failed http://b']);
  });

  it('times out hanging candidates', async () => {
    vi.useFakeTimers();
    const { controller } = create(['hang', 'ok'], { startupTimeoutMs: 1_000 });
    controller.play(async () => plan('http://hang', 'http://ok'));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(controller.getSnapshot()).toMatchObject({ status: 'playing', attempt: { index: 1 } });
    controller.destroy();
  });

  it('drops results of a superseded play() (fast zapping)', async () => {
    const { controller, engines } = create(['ok', 'ok']);
    let releaseFirst: (value: PlaybackPlanDto) => void = () => undefined;
    controller.play(() => new Promise((resolve) => (releaseFirst = resolve)));
    controller.play(async () => plan('http://second'));
    await settle();
    releaseFirst(plan('http://first'));
    await settle();
    expect(engines.map((e) => e.url)).toEqual(['http://second']);
  });

  it('starts muted when autoplay with sound is blocked', async () => {
    video.blockUnmutedAutoplay = true;
    const { controller } = create(['ok']);
    controller.play(async () => plan('http://a'));
    await settle();
    expect(video.muted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ status: 'playing', mutedByAutoplayPolicy: true });
  });

  it('reconnects with a fresh plan after a runtime failure', async () => {
    vi.useFakeTimers();
    const { controller, engines } = create(['ok', 'ok']);
    const resolver = vi.fn(async () => plan(`http://token-${resolver.mock.calls.length}`));
    controller.play(resolver);
    await vi.advanceTimersByTimeAsync(0);

    engines[0]!.fatal(new EngineError('segment 403', 'network', 403));
    expect(controller.getSnapshot().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(engines.map((e) => [e.url, e.destroyed])).toEqual([
      ['http://token-1', true],
      ['http://token-2', false],
    ]);
    expect(controller.getSnapshot().status).toBe('playing');
    controller.destroy();
  });

  it('surfaces API refusals (e.g. web pages) without retrying', async () => {
    const { controller, engines } = create([]);
    controller.play(async () => {
      throw new ApiError(422, 'UNPLAYABLE', 'This entry links to a web page.', { reason: 'web_page', url: 'https://youtube.com/x' });
    });
    await settle();
    expect(engines).toHaveLength(0);
    expect(controller.getSnapshot().failure).toMatchObject({ externalUrl: 'https://youtube.com/x', retryable: false });
  });
});
