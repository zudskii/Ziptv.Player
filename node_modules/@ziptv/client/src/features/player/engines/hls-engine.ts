import Hls, { ErrorDetails, ErrorTypes, Events, type ErrorData } from 'hls.js';

import { createNativeEngine } from './native-engine';
import { EngineError, engineOptions, resetMediaElement, waitForCanPlay, type EngineFactory } from './types';

const MAX_NETWORK_RECOVERIES = 3;
const MAX_MEDIA_RECOVERIES = 2;

/** HLS through hls.js (MSE); falls back to native HLS (iOS Safari without MSE). */
export const createHlsEngine: EngineFactory = (video, url) => {
  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) return createNativeEngine(video, url);
    throw new EngineError('HLS playback is not supported by this browser.', 'unsupported');
  }

  const hls = new Hls({
    enableWorker: engineOptions.worker,
    backBufferLength: 30,
    maxBufferLength: 30,
    liveDurationInfinity: true,
    // Fail fast on startup so the next candidate (e.g. the proxy) is tried quickly…
    manifestLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 15_000,
        timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1_000 },
      },
    },
    // …but be patient with segments of a stream that already plays.
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 60_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
      },
    },
  });

  const listeners = new Set<(error: EngineError) => void>();
  let started = false;
  let networkRecoveries = 0;
  let mediaRecoveries = 0;
  let rejectStartup: (error: EngineError) => void = () => undefined;

  const readiness = waitForCanPlay(video);
  const ready = new Promise<void>((resolve, reject) => {
    rejectStartup = reject;
    readiness.promise.then(() => {
      started = true;
      resolve();
    }, reject);
  });

  hls.on(Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (!started) {
      rejectStartup(toEngineError(data));
      return;
    }
    // hls.js recommended recovery ladder before giving up.
    if (data.type === ErrorTypes.NETWORK_ERROR && networkRecoveries < MAX_NETWORK_RECOVERIES) {
      networkRecoveries++;
      hls.startLoad();
      return;
    }
    if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries < MAX_MEDIA_RECOVERIES) {
      mediaRecoveries++;
      if (mediaRecoveries === 2) hls.swapAudioCodec();
      hls.recoverMediaError();
      return;
    }
    const error = toEngineError(data);
    listeners.forEach((listener) => listener(error));
  });
  // A healthy fragment resets the recovery budget.
  hls.on(Events.FRAG_BUFFERED, () => {
    networkRecoveries = 0;
    mediaRecoveries = 0;
  });

  const trackListeners = new Set<() => void>();
  const tracksChanged = () => trackListeners.forEach((listener) => listener());
  for (const event of [Events.AUDIO_TRACKS_UPDATED, Events.AUDIO_TRACK_SWITCHED, Events.SUBTITLE_TRACKS_UPDATED, Events.SUBTITLE_TRACK_SWITCH, Events.MANIFEST_PARSED] as const) {
    hls.on(event, tracksChanged);
  }

  hls.loadSource(url);
  hls.attachMedia(video);

  return {
    ready,
    onFatal: (listener) => listeners.add(listener),
    qualityLevels: () =>
      hls.levels.length > 1
        ? [
            { index: -1, label: 'Auto' },
            ...hls.levels
              .map((level, index) => ({
                index,
                label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`,
                sort: level.height || level.bitrate,
              }))
              .sort((a, b) => b.sort - a.sort)
              .map(({ index, label }) => ({ index, label })),
          ]
        : [],
    currentQuality: () => (hls.autoLevelEnabled ? -1 : hls.currentLevel),
    setQuality: (index) => {
      hls.currentLevel = index;
    },
    tracks: () => ({
      audio: hls.audioTracks.length > 1 ? hls.audioTracks.map((track, index) => ({ index, label: track.name || track.lang || `Audio ${index + 1}`, language: track.lang ?? '' })) : [],
      audioIndex: hls.audioTrack,
      subtitles: hls.subtitleTracks.map((track, index) => ({ index, label: track.name || track.lang || `Subtitles ${index + 1}`, language: track.lang ?? '' })),
      subtitleIndex: hls.subtitleDisplay ? hls.subtitleTrack : -1,
    }),
    setAudioTrack: (index) => {
      hls.audioTrack = index;
    },
    setSubtitleTrack: (index) => {
      hls.subtitleDisplay = index >= 0;
      hls.subtitleTrack = index;
    },
    onTracksChanged: (listener) => trackListeners.add(listener),
    goLive: () => {
      if (hls.liveSyncPosition !== null && Number.isFinite(hls.liveSyncPosition)) video.currentTime = hls.liveSyncPosition;
    },
    destroy: () => {
      readiness.cancel();
      listeners.clear();
      trackListeners.clear();
      hls.destroy();
      resetMediaElement(video);
    },
  };
};

function toEngineError(data: ErrorData): EngineError {
  const status = data.response?.code;
  const statusText = status ? ` (HTTP ${status})` : '';
  switch (data.details) {
    case ErrorDetails.MANIFEST_LOAD_ERROR:
    case ErrorDetails.LEVEL_LOAD_ERROR:
      return new EngineError(`Could not load the stream playlist${statusText}.`, 'network', status || undefined);
    case ErrorDetails.MANIFEST_LOAD_TIMEOUT:
    case ErrorDetails.LEVEL_LOAD_TIMEOUT:
    case ErrorDetails.FRAG_LOAD_TIMEOUT:
      return new EngineError('The stream server did not answer in time.', 'timeout');
    case ErrorDetails.MANIFEST_PARSING_ERROR:
      return new EngineError('The response is not a valid HLS playlist.', 'media');
    case ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR:
      return new EngineError('The stream uses codecs this browser cannot play.', 'unsupported');
    case ErrorDetails.FRAG_LOAD_ERROR:
      return new EngineError(`Could not load video segments${statusText}.`, 'network', status || undefined);
    default:
      return new EngineError(
        data.type === ErrorTypes.MEDIA_ERROR ? 'The stream could not be decoded.' : `Playback failed (${data.details}).`,
        data.type === ErrorTypes.NETWORK_ERROR ? 'network' : data.type === ErrorTypes.MEDIA_ERROR ? 'media' : 'other',
        status || undefined,
      );
  }
}
