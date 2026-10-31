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
}

/**
 * TV-remote friendly shortcuts. Ignored while typing in inputs.
 *   Space/K play-pause · M mute · F fullscreen · ↑/↓ volume · ←/→ seek (VOD)
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
        default:
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
