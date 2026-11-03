import type { ContentRefDto, PlaybackPlanDto, ResolvePlaybackRequest } from '@ziptv/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { billingApi } from '../billing/api';
import { DeviceRegistry } from '../billing/device';
import { OperatorPlaybackSessions } from '../billing/operator-sessions';
import { useSessionStore } from '../session/session';

import { config } from '../../config';
import { apiRequest } from '../../lib/api-client';
import { IDLE_SNAPSHOT, PlaybackController, type PlaybackSnapshot } from './playback-controller';

export function resolvePlayback(request: ResolvePlaybackRequest, signal?: AbortSignal): Promise<PlaybackPlanDto> {
  return apiRequest<PlaybackPlanDto>('/api/v1/playback', { method: 'POST', body: request, signal });
}

/** One registration per browser and identity, shared by every player on the page. */
const devices = new DeviceRegistry(billingApi.registerDevice);

const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_SNAPSHOT;

/**
 * Binds a PlaybackController to a <video> via a callback ref (React 19 ref cleanup),
 * so the controller lives exactly as long as the element.
 */
export function usePlaybackController() {
  const [state, setState] = useState<{ video: HTMLVideoElement; controller: PlaybackController; operatorSessions: OperatorPlaybackSessions } | null>(null);

  const videoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    const controller = new PlaybackController(video);
    // Operator channels play through authorized playback sessions (entitlement, device, concurrent
    // streams, country — Blueprint §8): kept alive by heartbeats, ended when the player stops or
    // the tab closes; a withdrawn authorization stops the player.
    const operatorSessions = new OperatorPlaybackSessions(billingApi, devices, () => useSessionStore.getState().token ?? '');
    operatorSessions.onLost((error) => controller.interrupt(error));
    const onPageHide = () => operatorSessions.release(true);
    // Back from the back/forward cache: the viewing was released on pagehide, so its links are dead.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller.retry();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    setState({ video, controller, operatorSessions });
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      operatorSessions.dispose();
      controller.destroy();
      setState(null);
    };
  }, []);

  const controller = state?.controller ?? null;
  const snapshot: PlaybackSnapshot = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : idleSnapshot,
  );

  return { videoRef, video: state?.video ?? null, controller, operatorSessions: state?.operatorSessions ?? null, snapshot };
}

/** Stable identity of a content reference (effects re-run only when *what* to play changes). */
export function contentKey(content: ContentRefDto | undefined | null): string {
  if (!content) return '';
  switch (content.type) {
    case 'episode':
      return `episode:${content.sourceId}:${content.seriesKey}:${content.key}`;
    case 'catchup':
      return `catchup:${content.sourceId}:${content.key}:${content.start}`;
    case 'operator':
      return `operator:${content.channelId}${content.start ? `:${content.start}` : ''}`;
    default:
      return `${content.type}:${content.sourceId}:${content.key}`;
  }
}

/** Starts/stops playback whenever the selected content changes. */
export function useContentPlayback(controller: PlaybackController | null, content: ContentRefDto | undefined, unlockToken?: string | null, operatorSessions?: OperatorPlaybackSessions | null) {
  const key = contentKey(content);
  const latest = useRef(content);
  useEffect(() => {
    latest.current = content;
  });

  useEffect(() => {
    if (!controller) return;
    const current = latest.current;
    if (!key || !current) {
      controller.stop();
      operatorSessions?.release();
      return;
    }
    if (current.type === 'operator') {
      if (!operatorSessions) return;
      const channelId = current.channelId;
      const archive = current.start && current.end ? { start: current.start, end: current.end } : undefined;
      controller.play((signal, context) => operatorSessions.resolve(channelId, config.isSecurePage, signal, context.continueSession, archive));
      return;
    }
    operatorSessions?.release();
    // The viewing this player moves away from: its provider connection is freed (accounts with a connection limit).
    const previous = controller.getSnapshot().plan?.sessionId;
    controller.play((signal, context) =>
      resolvePlayback(
        {
          content: current,
          secureContext: config.isSecurePage,
          ...(unlockToken ? { unlockToken } : {}),
          ...(context.continueSession ? { continueSession: context.continueSession } : {}),
          ...(previous && previous !== context.continueSession ? { replaces: previous } : {}),
        },
        signal,
      ),
    );
  }, [controller, key, unlockToken, operatorSessions]);
}
