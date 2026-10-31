import type { PlaybackEventRequest, PlaybackEventType } from '@ziptv/contracts';
import { useEffect, useRef } from 'react';

import { apiRequest } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import type { PlaybackSnapshot } from './playback-controller';

const HEARTBEAT_MS = 30_000;

function send(event: PlaybackEventRequest, keepalive = false): Promise<void> {
  // Fire and forget: watch history must never disturb playback.
  return apiRequest<void>('/api/v1/playback/events', { method: 'POST', body: event, keepalive, renewOn401: false }).catch(() => undefined);
}

/** Continue Watching / History / details changed on the server once a viewing ends. */
function refreshPersonalState(): void {
  for (const key of [['home'], ['progress'], ['history'], ['vod']]) void queryClient.invalidateQueries({ queryKey: key });
}

/**
 * Reports a viewing to the server: `start` once the stream plays, a heartbeat every 30 s while
 * playing (and on pause/seek end), `stop` when the viewing ends (next item, page closed).
 * The server turns these into Watch History and, for movies/episodes, Continue Watching.
 */
export function usePlaybackReporting(video: HTMLVideoElement | null, snapshot: PlaybackSnapshot): void {
  const sessionId = snapshot.plan?.sessionId ?? null;
  const vod = snapshot.plan ? snapshot.plan.content.mode !== 'live' : false;
  // Buffering is part of watching (no new 'start' after every stall); pause is not.
  const playing = snapshot.status === 'playing' || snapshot.status === 'buffering';
  const started = useRef<string | null>(null);

  const event = (type: PlaybackEventType): PlaybackEventRequest | null => {
    if (!sessionId) return null;
    const base: PlaybackEventRequest = { sessionId, type };
    if (vod && video && Number.isFinite(video.duration) && video.duration > 0) {
      return { ...base, position: Math.max(0, video.currentTime), duration: video.duration };
    }
    return base;
  };
  const latest = useRef(event);
  useEffect(() => {
    latest.current = event;
  });

  // start (once per viewing) + periodic heartbeats while playing
  useEffect(() => {
    if (!sessionId || !playing) return;
    // First play, and every resume after a pause: 'start' credits no watch time, so a paused
    // period is never counted as watched.
    started.current = sessionId;
    const start = latest.current('start');
    if (start) void send(start);
    const timer = setInterval(() => {
      const beat = latest.current('heartbeat');
      if (beat) void send(beat);
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [sessionId, playing]);

  // pause / seek / end → save the position right away (VOD)
  useEffect(() => {
    if (!video || !sessionId || !vod) return;
    const save = () => {
      if (started.current !== sessionId) return;
      const beat = latest.current('heartbeat');
      if (beat) void send(beat);
    };
    // A seek while paused would credit the paused time; its position is saved on resume.
    const seeked = () => !video.paused && save();
    video.addEventListener('pause', save);
    video.addEventListener('seeked', seeked);
    video.addEventListener('ended', save);
    return () => {
      video.removeEventListener('pause', save);
      video.removeEventListener('seeked', seeked);
      video.removeEventListener('ended', save);
    };
  }, [video, sessionId, vod]);

  // stop: the viewing changes, the player unmounts, or the page goes away
  useEffect(() => {
    if (!sessionId) return;
    const stop = () => {
      if (started.current !== sessionId) return;
      const final = latest.current('stop');
      if (final) void send(final, true).then(refreshPersonalState);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('visibilitychange', onHide);
      stop();
    };
  }, [sessionId]);
}
