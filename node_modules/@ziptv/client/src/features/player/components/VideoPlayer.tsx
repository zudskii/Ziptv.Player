import type { ChannelDto } from '@ziptv/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { changeVolume, restoreAudio, setMuted, toggleFullscreen, toggleMute, togglePlay } from '../media-actions';
import { usePlayerPrefs } from '../player-prefs';
import { useChannelPlayback, usePlaybackController } from '../use-playback';
import { usePlayerShortcuts } from '../use-player-shortcuts';
import { useVideoState } from '../use-video-state';
import { PlayerControls } from './PlayerControls';
import { PlayerOverlay } from './PlayerOverlay';

const CONTROLS_HIDE_DELAY_MS = 2500;

interface VideoPlayerProps {
  playlistId: string | undefined;
  channel: ChannelDto | undefined;
  onNext: () => void;
  onPrevious: () => void;
}

export function VideoPlayer({ playlistId, channel, onNext, onPrevious }: VideoPlayerProps) {
  const { videoRef, video, controller, snapshot } = usePlaybackController();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const state = useVideoState(video, container);
  useChannelPlayback(controller, playlistId, channel?.key);

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
  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);
  const showControls = controlsVisible || state.paused || snapshot.status !== 'playing';

  usePlayerShortcuts({
    togglePlay: () => togglePlay(video),
    toggleMute: () => toggleMute(video),
    toggleFullscreen: () => void toggleFullscreen(container, video),
    volume: (delta) => changeVolume(video, delta),
    nextChannel: onNext,
    previousChannel: onPrevious,
  });

  return (
    <div
      ref={setContainer}
      data-player-status={snapshot.status}
      className="group relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10 [&:fullscreen]:rounded-none"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
      onClick={() => {
        revealControls();
        if (snapshot.status === 'playing' || snapshot.status === 'paused') togglePlay(video);
      }}
      onDoubleClick={() => void toggleFullscreen(container, video)}
    >
      <video ref={videoRef} className="h-full w-full bg-black object-contain" playsInline preload="none" aria-label={channel?.name ?? 'Video player'} />

      <PlayerOverlay
        snapshot={snapshot}
        hasChannel={Boolean(channel)}
        onRetry={() => controller?.retry()}
        onNext={onNext}
        onStart={() => void video?.play().catch(() => undefined)}
        onUnmute={() => setMuted(video, false)}
      />

      {channel && (
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
