import { useMemo, useSyncExternalStore } from 'react';

export interface VideoState {
  paused: boolean;
  muted: boolean;
  volume: number;
  pictureInPicture: boolean;
  fullscreen: boolean;
}

const INITIAL: VideoState = { paused: true, muted: false, volume: 1, pictureInPicture: false, fullscreen: false };
const VIDEO_EVENTS = ['play', 'pause', 'playing', 'volumechange', 'enterpictureinpicture', 'leavepictureinpicture', 'emptied'];

/** Mirrors the element's own state into React; the element stays the single source of truth. */
export function useVideoState(video: HTMLVideoElement | null, container: HTMLElement | null): VideoState {
  const store = useMemo(() => createVideoStore(video, container), [video, container]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => INITIAL);
}

function createVideoStore(video: HTMLVideoElement | null, container: HTMLElement | null) {
  let snapshot = INITIAL;

  const read = (): VideoState => {
    if (!video) return INITIAL;
    const next: VideoState = {
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      pictureInPicture: document.pictureInPictureElement === video,
      fullscreen: Boolean(container && document.fullscreenElement === container),
    };
    const changed = (Object.keys(next) as (keyof VideoState)[]).some((key) => next[key] !== snapshot[key]);
    if (changed) snapshot = next;
    return snapshot;
  };

  return {
    getSnapshot: read,
    subscribe(onChange: () => void) {
      if (!video) return () => undefined;
      VIDEO_EVENTS.forEach((event) => video.addEventListener(event, onChange));
      document.addEventListener('fullscreenchange', onChange);
      return () => {
        VIDEO_EVENTS.forEach((event) => video.removeEventListener(event, onChange));
        document.removeEventListener('fullscreenchange', onChange);
      };
    },
  };
}
