import type { ContentRefDto } from '@ziptv/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { changeVolume, restoreAudio, setMuted, toggleFullscreen, toggleMute, togglePlay } from '../media-actions';
import { usePlayerPrefs } from '../player-prefs';
import { useContentPlayback, usePlaybackController } from '../use-playback';
import { usePlayerShortcuts } from '../use-player-shortcuts';
import { useVideoState } from '../use-video-state';
import { PlayerControls } from './PlayerControls';
import { PlayerOverlay } from './PlayerOverlay';

const CONTROLS_HIDE_DELAY_MS = 2500;

interface VideoPlayerProps {
  content: ContentRefDto | undefined;
  /** Accessible name of the video element. */
  title?: string;
  emptyLabel?: string;
  onNext?: () => void;
  onPrevious?: () => void;
  onAlternate?: (ref: ContentRefDto) => void;
  onBack?: () => void;
  /** Drawn over the video while controls are visible (channel logo, now/next, timeline). */
  infoOverlay?: ReactNode;
  className?: string;
}

export function VideoPlayer({ content, title, emptyLabel, onNext, onPrevious, onAlternate, onBack, infoOverlay, className }: VideoPlayerProps) {
  const { videoRef, video, controller, snapshot } = usePlaybackController();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const state = useVideoState(video, container);
  useContentPlayback(controller, content);

  // --- persisted volume ------------------------------------------------------------------
  const saveVolume = usePlayerPrefs((prefs) => prefs.setVolume);
  const saveMuted = usePlayerPrefs((prefs) => prefs.setMuted);
  useEffect(() => {
    if (!video) return;
    // Restore once per element; afterwards the element is the source of truth.
    restoreAudio(video, usePlayerPrefs.getState());
    const persist = () => {
      saveVolume(video.volume);
      // Don't remember a mute that the browser's autoplay policy forced on us.
      if (!controller?.getSnapshot().mutedByAutoplayPolicy) saveMuted(video.muted);
    };
    video.addEventListener('volumechange', persist);
    return () => video.removeEventListener('volumechange', persist);
  }, [video, controller, saveVolume, saveMuted]);

  // --- auto-hiding controls --------------------------------------------------------------
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  const showControls = controlsVisible || state.paused || snapshot.status !== 'playing';

  usePlayerShortcuts({
    togglePlay: () => togglePlay(video),
    toggleMute: () => toggleMute(video),
    toggleFullscreen: () => void toggleFullscreen(container, video),
    volume: (delta) => changeVolume(video, delta),
    nextChannel: () => onNext?.(),
    previousChannel: () => onPrevious?.(),
  });

  return (
    <div
      ref={setContainer}
      data-player-status={snapshot.status}
      className={cn('group relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10 [&:fullscreen]:rounded-none', className)}
      onMouseMove={revealControls}
      onTouchStart={revealControls}
      onClick={() => {
        revealControls();
        if (snapshot.status === 'playing' || snapshot.status === 'paused') togglePlay(video);
      }}
      onDoubleClick={() => void toggleFullscreen(container, video)}
    >
      <video ref={videoRef} className="h-full w-full bg-black object-contain" playsInline preload="none" aria-label={title ?? 'Video player'} />

      {infoOverlay && content && snapshot.status !== 'error' && (
        <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 transition-opacity duration-300', showControls ? 'opacity-100' : 'opacity-0')}>
          {infoOverlay}
        </div>
      )}

      <PlayerOverlay
        snapshot={snapshot}
        hasContent={Boolean(content)}
        emptyLabel={emptyLabel}
        onRetry={() => controller?.retry()}
        onNext={onNext}
        onBack={onBack}
        onAlternate={onAlternate}
        onStart={() => void video?.play().catch(() => undefined)}
        onUnmute={() => setMuted(video, false)}
      />

      {content && (
        <PlayerControls
          video={video}
          container={container}
          controller={controller}
          snapshot={snapshot}
          state={state}
          visible={showControls}
          onNext={onNext}
          onPrevious={onPrevious}
        />
      )}
    </div>
  );
}
