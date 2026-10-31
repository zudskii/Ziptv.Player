import {
  Captions,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { IconButton } from '../../../components/ui/Button';
import { cn } from '../../../lib/cn';
import { formatTimecode } from '../../../lib/time';
import { canUsePictureInPicture, setVolume, toggleFullscreen, toggleMute, togglePictureInPicture, togglePlay } from '../media-actions';
import type { PlaybackController, PlaybackSnapshot } from '../playback-controller';
import type { VideoState } from '../use-video-state';

interface PlayerControlsProps {
  video: HTMLVideoElement | null;
  container: HTMLElement | null;
  controller: PlaybackController | null;
  snapshot: PlaybackSnapshot;
  state: VideoState;
  visible: boolean;
  onNext?: () => void;
  onPrevious?: () => void;
  /** "Next channel" (live) / "Next episode" (series). */
  nextLabel?: string;
}

export function PlayerControls({ video, container, controller, snapshot, state, visible, onNext, onPrevious, nextLabel = 'Next channel' }: PlayerControlsProps) {
  const active = snapshot.status !== 'idle';
  const vod = snapshot.plan ? snapshot.plan.content.mode !== 'live' : false;
  const VolumeIcon = state.muted || state.volume === 0 ? VolumeX : state.volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pb-2 pt-10 transition-opacity duration-300 sm:px-3',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      onClick={(event) => event.stopPropagation()}
    >
      {vod && <SeekBar video={video} controller={controller} />}
      <div className="flex items-center gap-0.5 sm:gap-1">
        <IconButton tone="onDark" label={state.paused ? 'Play (Space)' : 'Pause (Space)'} onClick={() => togglePlay(video)} disabled={!active}>
          {state.paused ? <Play className="h-5 w-5 fill-current" /> : <Pause className="h-5 w-5 fill-current" />}
        </IconButton>
        {vod && (
          <>
            <IconButton tone="onDark" label="Back 10 seconds (←)" onClick={() => controller?.seekBy(-10)} disabled={!active}>
              <RotateCcw className="h-4 w-4" />
            </IconButton>
            <IconButton tone="onDark" label="Forward 10 seconds (→)" onClick={() => controller?.seekBy(10)} disabled={!active}>
              <RotateCw className="h-4 w-4" />
            </IconButton>
          </>
        )}
        {onPrevious && (
          <IconButton tone="onDark" label="Previous channel (P)" onClick={onPrevious} className="hidden xs:inline-flex">
            <SkipBack className="h-4 w-4" />
          </IconButton>
        )}
        {onNext && (
          <IconButton tone="onDark" label={`${nextLabel} (N)`} onClick={onNext}>
            <SkipForward className="h-4 w-4" />
          </IconButton>
        )}

        <div className="group/volume flex items-center">
          <IconButton tone="onDark" label={state.muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => toggleMute(video)}>
            <VolumeIcon className="h-5 w-5" />
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.muted ? 0 : state.volume}
            aria-label="Volume"
            className="volume-slider ml-1 hidden w-24 sm:block"
            onChange={(event) => setVolume(video, Number(event.target.value))}
          />
        </div>

        {vod ? (
          <TimeLabel video={video} />
        ) : (
          <button
            type="button"
            onClick={() => controller?.goLive()}
            disabled={!active}
            className="ml-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/90 hover:bg-white/10 disabled:opacity-40 sm:ml-2"
            title="Jump to live"
          >
            <span className={cn('h-2 w-2 rounded-full', snapshot.status === 'playing' ? 'bg-red-500' : 'bg-slate-500')} />
            Live
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {(snapshot.tracks.audio.length > 1 || snapshot.tracks.subtitles.length > 0) && <TracksMenu controller={controller} snapshot={snapshot} />}
          {snapshot.qualities.length > 0 && <QualityMenu controller={controller} snapshot={snapshot} />}
          {canUsePictureInPicture() && (
            <IconButton tone="onDark" label="Picture in picture" active={state.pictureInPicture} onClick={() => void togglePictureInPicture(video)} disabled={!active}>
              <PictureInPicture2 className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton tone="onDark" label={state.fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={() => void toggleFullscreen(container, video)}>
            {state.fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

// --- VOD timeline ------------------------------------------------------------------------------

interface TimeSnapshot {
  current: number;
  duration: number;
  buffered: number;
}

const ZERO: TimeSnapshot = { current: 0, duration: 0, buffered: 0 };

/** currentTime / duration / buffered end of the element, updated on media events (~4×/s). */
function useMediaTime(video: HTMLVideoElement | null): TimeSnapshot {
  const [store] = useState(() => {
    let snapshot = ZERO;
    return {
      read(element: HTMLVideoElement | null): TimeSnapshot {
        if (!element) return ZERO;
        const duration = Number.isFinite(element.duration) ? element.duration : 0;
        const buffered = element.buffered.length > 0 ? element.buffered.end(element.buffered.length - 1) : 0;
        const next = { current: element.currentTime, duration, buffered };
        if (Math.abs(next.current - snapshot.current) >= 0.25 || next.duration !== snapshot.duration || Math.abs(next.buffered - snapshot.buffered) >= 1) snapshot = next;
        return snapshot;
      },
    };
  });
  return useSyncExternalStore(
    (onChange) => {
      if (!video) return () => undefined;
      const events = ['timeupdate', 'durationchange', 'progress', 'seeking', 'emptied'];
      events.forEach((event) => video.addEventListener(event, onChange));
      return () => events.forEach((event) => video.removeEventListener(event, onChange));
    },
    () => store.read(video),
    () => ZERO,
  );
}

function SeekBar({ video, controller }: { video: HTMLVideoElement | null; controller: PlaybackController | null }) {
  const time = useMediaTime(video);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? time.current;
  const max = time.duration || 1;
  const played = (value / max) * 100;
  const buffered = (time.buffered / max) * 100;
  useEffect(() => {
    if (dragging === null) return;
    const release = () => setDragging(null);
    window.addEventListener('pointerup', release);
    return () => window.removeEventListener('pointerup', release);
  }, [dragging]);
  return (
    <div className="group/seek relative mb-1 flex h-4 items-center px-1">
      <div className="pointer-events-none absolute inset-x-1 h-1 rounded-full bg-white/20 transition-[height] group-hover/seek:h-1.5">
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${Math.min(100, buffered)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.min(100, played)}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(value, max)}
        aria-label="Seek"
        aria-valuetext={`${formatTimecode(value)} of ${formatTimecode(time.duration)}`}
        disabled={!time.duration}
        onPointerDown={() => setDragging(time.current)}
        onChange={(event) => {
          const next = Number(event.target.value);
          setDragging(next);
          controller?.seekTo(next);
        }}
        className="seek-slider relative h-4 w-full cursor-pointer appearance-none bg-transparent"
      />
    </div>
  );
}

function TimeLabel({ video }: { video: HTMLVideoElement | null }) {
  const time = useMediaTime(video);
  return (
    <span className="ml-1 whitespace-nowrap text-xs tabular-nums text-white/85 sm:ml-2">
      {formatTimecode(time.current)}
      <span className="text-white/50"> / {formatTimecode(time.duration)}</span>
    </span>
  );
}

// --- menus -------------------------------------------------------------------------------------

function TracksMenu({ controller, snapshot }: { controller: PlaybackController | null; snapshot: PlaybackSnapshot }) {
  const { audio, audioIndex, subtitles, subtitleIndex } = snapshot.tracks;
  return (
    <MenuButton label="Audio and subtitles" icon={<Captions className="h-4 w-4" />}>
      {(close) => (
        <>
          {audio.length > 1 && (
            <MenuGroup title="Audio">
              {audio.map((track) => (
                <MenuOption key={`a${track.index}`} checked={track.index === audioIndex} onClick={() => (controller?.setAudioTrack(track.index), close())}>
                  {track.label}
                </MenuOption>
              ))}
            </MenuGroup>
          )}
          {subtitles.length > 0 && (
            <MenuGroup title="Subtitles">
              <MenuOption checked={subtitleIndex < 0} onClick={() => (controller?.setSubtitleTrack(-1), close())}>
                Off
              </MenuOption>
              {subtitles.map((track) => (
                <MenuOption key={`s${track.index}`} checked={track.index === subtitleIndex} onClick={() => (controller?.setSubtitleTrack(track.index), close())}>
                  {track.label}
                </MenuOption>
              ))}
            </MenuGroup>
          )}
        </>
      )}
    </MenuButton>
  );
}

function QualityMenu({ controller, snapshot }: { controller: PlaybackController | null; snapshot: PlaybackSnapshot }) {
  const current = snapshot.qualities.find((level) => level.index === snapshot.quality)?.label ?? 'Auto';
  return (
    <MenuButton label="Quality" icon={<Settings2 className="h-4 w-4" />} text={current}>
      {(close) =>
        snapshot.qualities.map((level) => (
          <MenuOption key={level.index} checked={level.index === snapshot.quality} onClick={() => (controller?.setQuality(level.index), close())}>
            {level.label}
          </MenuOption>
        ))
      }
    </MenuButton>
  );
}

function MenuButton({ label, icon, text, children }: { label: string; icon: ReactNode; text?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-white/90 hover:bg-white/10"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        {icon}
        {text}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-11 right-0 max-h-72 min-w-36 overflow-y-auto rounded-lg border border-white/10 bg-ink-850/95 py-1 text-sm shadow-xl backdrop-blur">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-0.5">
      <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">{title}</p>
      {children}
    </div>
  );
}

function MenuOption({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className={cn('block w-full px-3 py-1.5 text-left hover:bg-white/10', checked ? 'text-blue-300' : 'text-white/90')}
    >
      {children}
    </button>
  );
}
