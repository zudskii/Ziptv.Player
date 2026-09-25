import { MediaPlayer, supportsMediaSource } from 'dashjs';

import { EngineError, resetMediaElement, seekToLiveEdge, waitForCanPlay, type EngineFactory } from './types';

/** MPEG-DASH (clear, non-DRM) via dash.js. Loaded lazily — most playlists never need it. */
export const createDashEngine: EngineFactory = (video, url) => {
  if (!supportsMediaSource()) throw new EngineError('MPEG-DASH needs Media Source Extensions, which this browser does not support.', 'unsupported');

  const player = MediaPlayer().create();
  const listeners = new Set<(error: EngineError) => void>();
  let started = false;
  let rejectStartup: (error: EngineError) => void = () => undefined;

  const readiness = waitForCanPlay(video);
  const ready = new Promise<void>((resolve, reject) => {
    rejectStartup = reject;
    readiness.promise.then(() => {
      started = true;
      resolve();
    }, reject);
  });

  player.on(MediaPlayer.events.ERROR, (event: { error?: unknown }) => {
    const error = new EngineError(describe(event.error), 'network');
    if (!started) rejectStartup(error);
    else listeners.forEach((listener) => listener(error));
  });
  player.initialize(video, url, false);

  return {
    ready,
    onFatal: (listener) => listeners.add(listener),
    qualityLevels: () => [],
    currentQuality: () => -1,
    setQuality: () => undefined,
    goLive: () => seekToLiveEdge(video),
    destroy: () => {
      readiness.cancel();
      listeners.clear();
      try {
        player.destroy();
      } catch {
        /* already destroyed */
      }
      resetMediaElement(video);
    },
  };
};

function describe(error: unknown): string {
  if (typeof error === 'string') return `MPEG-DASH playback failed (${error}).`;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'MPEG-DASH playback failed.';
}
