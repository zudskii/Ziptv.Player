/** Imperative media helpers shared by the controls and keyboard shortcuts. */

export function togglePlay(video: HTMLVideoElement | null): void {
  if (!video) return;
  if (video.paused) void video.play().catch(() => undefined);
  else video.pause();
}

export function toggleMute(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) video.volume = 0.5;
}

export function setVolume(video: HTMLVideoElement | null, volume: number): void {
  if (!video) return;
  video.volume = Math.min(1, Math.max(0, volume));
  video.muted = video.volume === 0;
}

export function setMuted(video: HTMLVideoElement | null, muted: boolean): void {
  if (video) video.muted = muted;
}

/** Applies persisted preferences to a freshly attached element. */
export function restoreAudio(video: HTMLVideoElement, prefs: { volume: number; muted: boolean }): void {
  video.volume = prefs.volume;
  video.muted = prefs.muted;
}

export function changeVolume(video: HTMLVideoElement | null, delta: number): void {
  if (!video) return;
  video.volume = Math.min(1, Math.max(0, Math.round((video.volume + delta) * 100) / 100));
  video.muted = video.volume === 0;
}

export async function toggleFullscreen(container: HTMLElement | null, video: HTMLVideoElement | null): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (container?.requestFullscreen) {
      await container.requestFullscreen();
    } else {
      // iOS Safari only supports fullscreen on the video element itself.
      (video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
    }
  } catch {
    /* user gesture requirements / unsupported */
  }
}

export function canUsePictureInPicture(): boolean {
  return typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
}

export async function togglePictureInPicture(video: HTMLVideoElement | null): Promise<void> {
  if (!video || !canUsePictureInPicture()) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch {
    /* not available for this stream */
  }
}
