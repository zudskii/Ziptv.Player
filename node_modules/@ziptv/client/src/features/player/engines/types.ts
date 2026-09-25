export type EngineErrorKind = 'network' | 'media' | 'unsupported' | 'timeout' | 'other';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly kind: EngineErrorKind,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface QualityLevel {
  /** Engine-specific index; -1 means automatic. */
  index: number;
  label: string;
}

/** A playback library (hls.js, mpegts.js, dash.js, native) attached to a <video> element. */
export interface EngineHandle {
  /** Resolves when the first frame can be rendered, rejects if the stream cannot start. */
  readonly ready: Promise<void>;
  /** Unrecoverable failure *after* startup (the engine already tried its own recovery). */
  onFatal(listener: (error: EngineError) => void): void;
  qualityLevels(): QualityLevel[];
  /** -1 = automatic. */
  currentQuality(): number;
  setQuality(index: number): void;
  /** Jump to the live edge (after a pause on a live stream). */
  goLive(): void;
  destroy(): void;
}

export type EngineFactory = (video: HTMLVideoElement, url: string) => EngineHandle;

/** Resolves on `canplay`, rejects on a media error — shared by engines that rely on the element. */
export function waitForCanPlay(video: HTMLVideoElement): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(mediaElementError(video));
    };
    const cleanup = () => {
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    cancel = cleanup;
    video.addEventListener('canplay', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
  });
  return { promise, cancel };
}

export function mediaElementError(video: HTMLVideoElement): EngineError {
  const code = video.error?.code;
  switch (code) {
    case 2:
      return new EngineError('Network error while loading the stream.', 'network');
    case 3:
      return new EngineError('The stream could not be decoded.', 'media');
    case 4:
      return new EngineError('This stream format or codec is not supported by the browser.', 'unsupported');
    default:
      return new EngineError(video.error?.message || 'The media element failed.', 'other');
  }
}

/** Seek to the end of the seekable window (works for any engine). */
export function seekToLiveEdge(video: HTMLVideoElement): void {
  const { seekable } = video;
  if (seekable.length > 0) video.currentTime = Math.max(0, seekable.end(seekable.length - 1) - 2);
}

export function resetMediaElement(video: HTMLVideoElement): void {
  video.removeAttribute('src');
  try {
    video.load();
  } catch {
    /* element already detached */
  }
}
