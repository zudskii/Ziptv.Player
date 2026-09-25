import type { PlaybackPlanDto, ResolvePlaybackRequest } from '@ziptv/contracts';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

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

/** Starts/stops playback whenever the selected channel changes. */
export function useChannelPlayback(controller: PlaybackController | null, playlistId: string | undefined, channelKey: string | undefined) {
  useEffect(() => {
    if (!controller) return;
    if (!playlistId || !channelKey) {
      controller.stop();
      return;
    }
    controller.play((signal) => resolvePlayback({ playlistId, channelKey, secureContext: config.isSecurePage }, signal));
  }, [controller, playlistId, channelKey]);
}
