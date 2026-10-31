import type { ContentRefDto, PlaybackPlanDto, ResolvePlaybackRequest } from '@ziptv/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { config } from '../../config';
import { apiRequest } from '../../lib/api-client';
import { IDLE_SNAPSHOT, PlaybackController, type PlaybackSnapshot } from './playback-controller';

export function resolvePlayback(request: ResolvePlaybackRequest, signal?: AbortSignal): Promise<PlaybackPlanDto> {
  return apiRequest<PlaybackPlanDto>('/api/v1/playback', { method: 'POST', body: request, signal });
}

const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE_SNAPSHOT;

/**
 * Binds a PlaybackController to a <video> via a callback ref (React 19 ref cleanup),
 * so the controller lives exactly as long as the element.
 */
export function usePlaybackController() {
  const [state, setState] = useState<{ video: HTMLVideoElement; controller: PlaybackController } | null>(null);

  const videoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    const controller = new PlaybackController(video);
    setState({ video, controller });
    return () => {
      controller.destroy();
      setState(null);
    };
  }, []);

  const controller = state?.controller ?? null;
  const snapshot: PlaybackSnapshot = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : idleSnapshot,
  );

  return { videoRef, video: state?.video ?? null, controller, snapshot };
}

/** Stable identity of a content reference (effects re-run only when *what* to play changes). */
export function contentKey(content: ContentRefDto | undefined | null): string {
  if (!content) return '';
  switch (content.type) {
    case 'episode':
      return `episode:${content.sourceId}:${content.seriesKey}:${content.key}`;
    case 'catchup':
      return `catchup:${content.sourceId}:${content.key}:${content.start}`;
    default:
      return `${content.type}:${content.sourceId}:${content.key}`;
  }
}

/** Starts/stops playback whenever the selected content changes. */
export function useContentPlayback(controller: PlaybackController | null, content: ContentRefDto | undefined, unlockToken?: string | null) {
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
      return;
    }
    controller.play((signal, context) =>
      resolvePlayback(
        { content: current, secureContext: config.isSecurePage, ...(unlockToken ? { unlockToken } : {}), ...(context.continueSession ? { continueSession: context.continueSession } : {}) },
        signal,
      ),
    );
  }, [controller, key, unlockToken]);
}
