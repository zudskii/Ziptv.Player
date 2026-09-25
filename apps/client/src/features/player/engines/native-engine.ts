import {
  mediaElementError,
  resetMediaElement,
  seekToLiveEdge,
  waitForCanPlay,
  type EngineError,
  type EngineFactory,
} from './types';

/** `<video src>` — progressive MP4/WebM/MP3 and Safari's built-in HLS. */
export const createNativeEngine: EngineFactory = (video, url) => {
  const listeners = new Set<(error: EngineError) => void>();
  let started = false;
  const onError = () => {
    if (started) listeners.forEach((listener) => listener(mediaElementError(video)));
  };

  const readiness = waitForCanPlay(video);
  video.addEventListener('error', onError);
  video.src = url;
  video.load();

  return {
    ready: readiness.promise.then(() => {
      started = true;
    }),
    onFatal: (listener) => listeners.add(listener),
    qualityLevels: () => [],
    currentQuality: () => -1,
    setQuality: () => undefined,
    goLive: () => seekToLiveEdge(video),
    destroy: () => {
      readiness.cancel();
      video.removeEventListener('error', onError);
      listeners.clear();
      resetMediaElement(video);
    },
  };
};
