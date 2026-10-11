import {
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useState } from 'react';

import { IconButton } from '../../../components/ui/Button';
import { cn } from '../../../lib/cn';
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
}

export function PlayerControls({ video, container, controller, snapshot, state, visible, onNext, onPrevious }: PlayerControlsProps) {
  const [qualityOpen, setQualityOpen] = useState(false);
  const active = snapshot.status !== 'idle';
  const VolumeIcon = state.muted || state.volume === 0 ? VolumeX : state.volume < 0.5 ? Volume1 : Volume2;
  const currentQuality = snapshot.qualities.find((level) => level.index === snapshot.quality)?.label ?? 'Auto';

  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pb-2 pt-10 transition-opacity duration-300 sm:px-3',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-0.5 sm:gap-1">
        <IconButton tone="onDark" label={state.paused ? 'Play (Space)' : 'Pause (Space)'} onClick={() => togglePlay(video)} disabled={!active}>
          {state.paused ? <Play className="h-5 w-5 fill-current" /> : <Pause className="h-5 w-5 fill-current" />}
        </IconButton>
        {onPrevious && (
          <IconButton tone="onDark" label="Previous channel (P)" onClick={onPrevious} className="hidden xs:inline-flex">
            <SkipBack className="h-4 w-4" />
          </IconButton>
        )}
        {onNext && (
          <IconButton tone="onDark" label="Next channel (N)" onClick={onNext}>
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

        <div className="ml-auto flex items-center gap-1">
          {snapshot.qualities.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setQualityOpen((open) => !open)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-white/90 hover:bg-white/10"
                aria-haspopup="menu"
                aria-expanded={qualityOpen}
              >
                <Settings2 className="h-4 w-4" />
                {currentQuality}
              </button>
              {qualityOpen && (
                <ul role="menu" className="absolute bottom-11 right-0 min-w-28 overflow-hidden rounded-lg border border-white/10 bg-ink-850/95 py-1 text-sm shadow-xl backdrop-blur">
                  {snapshot.qualities.map((level) => (
                    <li key={level.index}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={level.index === snapshot.quality}
                        onClick={() => {
                          controller?.setQuality(level.index);
                          setQualityOpen(false);
                        }}
                        className={cn(
                          'w-full px-3 py-1.5 text-left hover:bg-white/10',
                          level.index === snapshot.quality ? 'text-blue-300' : 'text-white/90',
                        )}
                      >
                        {level.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
