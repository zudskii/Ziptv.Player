import { useEffect, useRef } from 'react';

export interface PlayerShortcutHandlers {
  togglePlay: () => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  volume: (delta: number) => void;
  nextChannel: () => void;
  previousChannel: () => void;
  /** VOD: ←/→ seek by ±10 s (absent for live, where ←/→ keep their default). */
  seek?: (delta: number) => void;
  /** VOD: 0–9 jump to 0–90 % of the programme. */
  seekToFraction?: (fraction: number) => void;
  togglePictureInPicture?: () => void;
  /** C: subtitles on/off. */
  toggleSubtitles?: () => void;
  /** ?: the shortcuts overview. */
  showHelp?: () => void;
}

/** The shortcuts the player understands (Settings → About and the "?" overlay list them). */
export const PLAYER_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Space / K', action: 'Play / pause' },
  { keys: '← / →', action: 'Back / forward 10 s (recordings, catch-up)' },
  { keys: '0 … 9', action: 'Jump to 0–90 % (recordings, catch-up)' },
  { keys: '↑ / ↓', action: 'Volume' },
  { keys: 'M', action: 'Mute' },
  { keys: 'F', action: 'Fullscreen' },
  { keys: 'I', action: 'Picture in picture' },
  { keys: 'C', action: 'Subtitles on / off' },
  { keys: 'N / P', action: 'Next / previous channel' },
  { keys: '?', action: 'This overview' },
];

/**
 * TV-remote friendly shortcuts. Ignored while typing in inputs.
 *   Space/K play-pause · M mute · F fullscreen · ↑/↓ volume · ←/→ seek and 0–9 jump (VOD)
 *   I picture-in-picture · C subtitles · ? overview
 *   PageDown/ChannelDown/N next · PageUp/ChannelUp/P previous
 */
export function usePlayerShortcuts(handlers: PlayerShortcutHandlers, enabled = true): void {
  // Latest handlers without re-binding the listener on every render.
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      const actions = ref.current;

      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          if (event.target instanceof HTMLButtonElement && event.key === ' ') return; // let buttons click
          actions.togglePlay();
          break;
        case 'm':
        case 'M':
          actions.toggleMute();
          break;
        case 'f':
        case 'F':
          actions.toggleFullscreen();
          break;
        case 'ArrowUp':
          if (isListTarget(event.target)) return;
          actions.volume(0.05);
          break;
        case 'ArrowDown':
          if (isListTarget(event.target)) return;
          actions.volume(-0.05);
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (!actions.seek || isListTarget(event.target) || event.target instanceof HTMLInputElement) return;
          actions.seek(event.key === 'ArrowLeft' ? -10 : 10);
          break;
        case 'PageDown':
        case 'ChannelDown':
        case 'n':
        case 'N':
          actions.nextChannel();
          break;
        case 'PageUp':
        case 'ChannelUp':
        case 'p':
        case 'P':
          actions.previousChannel();
          break;
        case 'i':
        case 'I':
          if (!actions.togglePictureInPicture) return;
          actions.togglePictureInPicture();
          break;
        case 'c':
        case 'C':
          if (!actions.toggleSubtitles) return;
          actions.toggleSubtitles();
          break;
        case '?':
          if (!actions.showHelp) return;
          actions.showHelp();
          break;
        default:
          if (/^[0-9]$/.test(event.key) && actions.seekToFraction) {
            actions.seekToFraction(Number(event.key) / 10);
            break;
          }
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function isListTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('[data-channel-list]'));
}
