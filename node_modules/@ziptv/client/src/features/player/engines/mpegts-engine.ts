import mpegts from 'mpegts.js';

import { EngineError, resetMediaElement, seekToLiveEdge, waitForCanPlay, type EngineFactory } from './types';

/**
 * Continuous MPEG-TS / FLV over HTTP (Xtream-style `…/123.ts` channels) via mpegts.js,
 * which transmuxes to fMP4 for Media Source Extensions.
 */
export function createMpegtsEngineFactory(type: 'mpegts' | 'flv'): EngineFactory {
  return (video, url) => {
    if (!mpegts.getFeatureList().mseLivePlayback) {
      // mpegts.js reports this when MSE is missing *or* cannot decode H.264/AAC (e.g. open-source Chromium).
      throw new EngineError('This browser cannot play MPEG-TS streams (needs Media Source Extensions with H.264/AAC support).', 'unsupported');
    }

    const player = mpegts.createPlayer(
      { type, isLive: true, url, cors: true },
      {
        // mpegts.js' worker is bundled for webpack only; the main thread is fine for one stream.
        enableWorker: false,
        enableStashBuffer: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 8,
        liveBufferLatencyMinRemain: 2,
        autoCleanupSourceBuffer: true,
        lazyLoad: false,
      },
    );

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

    player.on(mpegts.Events.ERROR, (errorType: string, details: string, info?: { code?: number; msg?: string }) => {
      const error = toEngineError(errorType, details, info);
      if (!started) rejectStartup(error);
      else listeners.forEach((listener) => listener(error));
    });

    player.attachMediaElement(video);
    player.load();

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
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          /* already torn down */
        }
        resetMediaElement(video);
      },
    };
  };
}

function toEngineError(errorType: string, details: string, info?: { code?: number; msg?: string }): EngineError {
  if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
    const status = details === mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID ? info?.code : undefined;
    if (details === mpegts.ErrorDetails.NETWORK_TIMEOUT) return new EngineError('The stream server did not answer in time.', 'timeout');
    return new EngineError(status ? `The stream server answered HTTP ${status}.` : 'Network error while loading the stream.', 'network', status);
  }
  if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
    return details === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED || details === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED
      ? new EngineError('This stream uses a codec the browser cannot play.', 'unsupported')
      : new EngineError('The stream could not be decoded.', 'media');
  }
  return new EngineError(info?.msg || 'Playback failed.', 'other');
}
