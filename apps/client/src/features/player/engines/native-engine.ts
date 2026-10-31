import {
  mediaElementError,
  resetMediaElement,
  seekToLiveEdge,
  waitForCanPlay,
  nativeTextTracks,
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
  const text = nativeTextTracks(video);
  const trackListeners = new Set<() => void>();
  const onTracks = () => trackListeners.forEach((listener) => listener());
  video.textTracks.addEventListener('addtrack', onTracks);
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
    tracks: () => ({ audio: [], audioIndex: -1, ...text.read() }),
    setSubtitleTrack: (index) => {
      text.setSubtitleTrack(index);
      onTracks();
    },
    onTracksChanged: (listener) => trackListeners.add(listener),
    destroy: () => {
      readiness.cancel();
      video.textTracks.removeEventListener('addtrack', onTracks);
      trackListeners.clear();
      video.removeEventListener('error', onError);
      listeners.clear();
      resetMediaElement(video);
    },
  };
};
