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

export interface MediaTrack {
  /** Engine-specific index. */
  index: number;
  label: string;
  /** BCP-47-ish language code as announced by the stream ('' when unknown). */
  language: string;
}

/** Audio and subtitle tracks of the current stream; subtitle index -1 = off. */
export interface TrackState {
  audio: MediaTrack[];
  audioIndex: number;
  subtitles: MediaTrack[];
  subtitleIndex: number;
}

export const NO_TRACKS: TrackState = { audio: [], audioIndex: -1, subtitles: [], subtitleIndex: -1 };

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
  /** Audio / subtitle tracks (optional: engines without track support report none). */
  tracks?(): TrackState;
  setAudioTrack?(index: number): void;
  setSubtitleTrack?(index: number): void;
  onTracksChanged?(listener: () => void): void;
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

/**
 * Subtitles through the element's own text tracks (progressive files with embedded captions,
 * Safari native HLS). Exactly one track is "showing"; the rest stay "disabled".
 */
export function nativeTextTracks(video: HTMLVideoElement): { read(): Pick<TrackState, 'subtitles' | 'subtitleIndex'>; setSubtitleTrack(index: number): void } {
  const list = () => Array.from(video.textTracks).filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
  return {
    read: () => {
      const tracks = list();
      return {
        subtitles: tracks.map((track, index) => ({ index, label: track.label || track.language || `Track ${index + 1}`, language: track.language })),
        subtitleIndex: tracks.findIndex((track) => track.mode === 'showing'),
      };
    },
    setSubtitleTrack: (index) => list().forEach((track, i) => (track.mode = i === index ? 'showing' : 'disabled')),
  };
}

/** Picks the track matching a preferred language ('' = keep default, 'off' = none for subtitles). */
export function preferredTrack(tracks: MediaTrack[], preference: string): number | null {
  if (!preference) return null;
  if (preference === 'off') return -1;
  const wanted = preference.toLowerCase();
  const base = wanted.split('-')[0]!;
  const match = tracks.find((track) => track.language.toLowerCase() === wanted) ?? tracks.find((track) => track.language.toLowerCase().split('-')[0] === base);
  return match ? match.index : null;
}

/** Device-level engine options (Settings → Playback → Hardware acceleration). */
export const engineOptions = { worker: true };

export function setEngineOptions(options: Partial<typeof engineOptions>): void {
  Object.assign(engineOptions, options);
}
