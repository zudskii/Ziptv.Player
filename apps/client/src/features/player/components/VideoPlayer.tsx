import type { ContentRefDto } from '@ziptv/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { changeVolume, restoreAudio, setMuted, toggleFullscreen, toggleMute, togglePictureInPicture, togglePlay } from '../media-actions';
import { useMediaSession } from '../use-media-session';
import { usePlayerPrefs } from '../player-prefs';
import { useSettings } from '../../user-state/api';
import { requestUnlock } from '../../parental/api';
import { profileKey, useParentalStore } from '../../parental/parental-store';
import { useProfileStore } from '../../profiles/profile-store';
import { useContentPlayback, usePlaybackController } from '../use-playback';
import { usePlaybackReporting } from '../use-playback-reporting';
import { PLAYER_SHORTCUTS, usePlayerShortcuts } from '../use-player-shortcuts';
import { useVideoState } from '../use-video-state';
import { PlayerControls } from './PlayerControls';
import { PlayerOverlay } from './PlayerOverlay';
import { t } from '../../../i18n';

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
  /** "Next channel" (live, default) or "Next episode". */
  nextLabel?: string;
  /** VOD finished: what comes next (episode autoplay countdown) — null shows "Watch again". */
  upNext?: { title: string; subtitle: string | null; autoplay: boolean } | null;
  /** Keyboard shortcuts (default on). Off for the tiles of Multi-view: only the focused one listens. */
  shortcuts?: boolean;
  /**
   * Multi-view: only the tile with audio focus is heard; the others play muted. When set, the
   * remembered volume is neither applied nor changed by this player.
   */
  audioFocus?: boolean;
}

export function VideoPlayer({ content, title, emptyLabel, onNext, onPrevious, onAlternate, onBack, infoOverlay, className, nextLabel, upNext, shortcuts = true, audioFocus }: VideoPlayerProps) {
  const { videoRef, video, controller, operatorSessions, snapshot } = usePlaybackController();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const state = useVideoState(video, container);
  const settingsQuery = useSettings();
  const settings = settingsQuery.data?.playback;
  // Declared before useContentPlayback: effects run in order, so the preferences are in place
  // before the stream starts (tracks, quality, resume).
  useEffect(() => {
    if (controller && settings) {
      controller.setPreferences({ audio: settings.preferredAudio, subtitles: settings.preferredSubtitles, quality: settings.preferredQuality, resume: settings.resumePlayback, autoplay: settings.autoplay });
    }
  }, [controller, settings]);
  // Settings decide autoplay/resume/tracks: start once they are known (cached after the first load).
  // A PIN unlock (token per profile) restarts a refused viewing by itself.
  const profileId = useProfileStore((state) => state.profileId);
  const unlockToken = useParentalStore((state) => {
    const unlock = state.unlocks[profileKey(profileId)];
    return unlock ? unlock.token : null;
  });
  useContentPlayback(controller, settingsQuery.isPending ? undefined : content, unlockToken, operatorSessions);
  // A viewing that failed (every feed down) must not keep holding one of the account's stream slots.
  useEffect(() => {
    if (snapshot.status === 'error') operatorSessions?.release();
  }, [snapshot.status, operatorSessions]);
  usePlaybackReporting(video, snapshot, controller);
  const vod = snapshot.plan ? snapshot.plan.content.mode !== 'live' : false;

  // --- persisted volume ------------------------------------------------------------------
  const saveVolume = usePlayerPrefs((prefs) => prefs.setVolume);
  const saveMuted = usePlayerPrefs((prefs) => prefs.setMuted);
  const tiled = audioFocus !== undefined;
  useEffect(() => {
    if (!video || tiled) return;
    // Restore once per element; afterwards the element is the source of truth.
    restoreAudio(video, usePlayerPrefs.getState());
    const persist = () => {
      saveVolume(video.volume);
      // Don't remember a mute that the browser's autoplay policy forced on us.
      if (!controller?.getSnapshot().mutedByAutoplayPolicy) saveMuted(video.muted);
    };
    video.addEventListener('volumechange', persist);
    return () => video.removeEventListener('volumechange', persist);
  }, [video, controller, saveVolume, saveMuted, tiled]);
  // Multi-view audio focus.
  useEffect(() => {
    if (video && audioFocus !== undefined) setMuted(video, !audioFocus);
  }, [video, audioFocus]);
  // System media controls (lock screen, headset keys, the picture-in-picture window).
  useMediaSession(audioFocus === false ? null : snapshot.plan, video, { onNext, onPrevious });
  const [help, setHelp] = useState(false);

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

  usePlayerShortcuts(
    {
      togglePlay: () => togglePlay(video),
      toggleMute: () => toggleMute(video),
      toggleFullscreen: () => void toggleFullscreen(container, video),
      volume: (delta) => changeVolume(video, delta),
      nextChannel: () => onNext?.(),
      previousChannel: () => onPrevious?.(),
      togglePictureInPicture: () => void togglePictureInPicture(video),
      toggleSubtitles: () => {
        const tracks = controller?.getSnapshot().tracks;
        if (!tracks || tracks.subtitles.length === 0) return;
        controller?.setSubtitleTrack(tracks.subtitleIndex >= 0 ? -1 : tracks.subtitles[0]!.index);
      },
      showHelp: () => setHelp((value) => !value),
      ...(vod
        ? {
            seek: (delta: number) => controller?.seekBy(delta),
            seekToFraction: (fraction: number) => {
              if (video && Number.isFinite(video.duration) && video.duration > 0) controller?.seekTo(video.duration * fraction);
            },
          }
        : {}),
    },
    shortcuts,
  );

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
      <video ref={videoRef} className="h-full w-full bg-black object-contain" playsInline preload="none" aria-label={title ?? t('player.videoPlayer')} />

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
        onUnlock={() => void requestUnlock()}
        onStart={() => void video?.play().catch(() => undefined)}
        onUnmute={() => setMuted(video, false)}
        nextLabel={nextLabel}
        upNext={upNext}
        onReplay={() => {
          controller?.seekTo(0);
          void video?.play().catch(() => undefined);
        }}
      />

      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

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
          nextLabel={nextLabel}
        />
      )}
    </div>
  );
}

/** "?" — the keyboard shortcuts, over the video. */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={(event) => (event.stopPropagation(), onClose())} role="dialog" aria-label={t('player.shortcuts')}>
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-white/10 bg-ink-900/95 p-4 text-white shadow-2xl">
        <p className="mb-2 text-sm font-semibold">{t('player.shortcuts')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {PLAYER_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="contents">
              <dt className="font-mono text-white/80">{shortcut.keys}</dt>
              <dd className="text-white/70">{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
