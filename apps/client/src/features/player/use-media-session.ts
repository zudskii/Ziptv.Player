import type { PlaybackPlanDto } from '@ziptv/contracts';
import { useEffect, useRef } from 'react';

import { resolveApiUrl } from '../../config';
import { t } from '../../i18n';

/**
 * Media Session API: the OS media controls (lock screen, headset buttons, the picture-in-picture
 * window, the browser's media hub) show what is playing and drive this player. Skipped where the
 * browser has no support; `plan = null` leaves the session to another player (Multi-view tiles
 * without audio focus).
 */
export function useMediaSession(plan: PlaybackPlanDto | null, video: HTMLVideoElement | null, actions: { onNext?: (() => void) | undefined; onPrevious?: (() => void) | undefined }): void {
  // Latest callbacks without re-registering the session on every render.
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  const hasNext = Boolean(actions.onNext);
  const hasPrevious = Boolean(actions.onPrevious);
  useEffect(() => {
    if (!plan || !video || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const { content } = plan;
    try {
      session.metadata = new MediaMetadata({
        title: content.title,
        artist: content.subtitle ?? content.channel?.name ?? 'ZIPTV',
        album: content.mode === 'live' ? t('player.ctl.live') : content.mode === 'catchup' ? t('player.catchup') : '',
        artwork: content.image ? [{ src: resolveApiUrl(content.image) }] : [],
      });
    } catch {
      /* MediaMetadata unsupported */
    }
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => void video.play().catch(() => undefined)],
      ['pause', () => video.pause()],
      ['nexttrack', hasNext ? () => latest.current.onNext?.() : null],
      ['previoustrack', hasPrevious ? () => latest.current.onPrevious?.() : null],
      ['seekbackward', content.mode === 'live' ? null : () => (video.currentTime = Math.max(0, video.currentTime - 10))],
      ['seekforward', content.mode === 'live' ? null : () => (video.currentTime = video.currentTime + 10)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* action unsupported by this browser */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
      session.metadata = null;
    };
  }, [plan, video, hasNext, hasPrevious]);
}
