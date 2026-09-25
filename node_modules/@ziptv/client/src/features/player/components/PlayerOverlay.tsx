import { ExternalLink, LoaderCircle, Play, RefreshCw, SkipForward, Tv, VolumeX } from 'lucide-react';

import { Button } from '../../../components/ui/Button';
import type { PlaybackSnapshot } from '../playback-controller';

interface PlayerOverlayProps {
  snapshot: PlaybackSnapshot;
  hasChannel: boolean;
  onRetry: () => void;
  onNext: () => void;
  onStart: () => void;
  onUnmute: () => void;
}

/** Everything drawn on top of the video: empty state, progress, autoplay prompts and errors. */
export function PlayerOverlay({ snapshot, hasChannel, onRetry, onNext, onStart, onUnmute }: PlayerOverlayProps) {
  if (!hasChannel) {
    return (
      <Centered>
        <Tv className="h-10 w-10 text-slate-500" aria-hidden />
        <p className="mt-3 text-sm text-slate-400">Pick a channel from the list to start watching.</p>
      </Centered>
    );
  }

  switch (snapshot.status) {
    case 'resolving':
    case 'connecting':
    case 'reconnecting':
    case 'buffering':
      return (
        <Centered passive>
          <LoaderCircle className="h-10 w-10 animate-spin text-white/90" aria-hidden />
          <p className="mt-3 rounded-full bg-black/50 px-3 py-1 text-xs text-slate-200" role="status">
            {progressLabel(snapshot)}
          </p>
        </Centered>
      );
    case 'blocked':
      return (
        <Centered>
          <button
            type="button"
            onClick={onStart}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-brand text-white shadow-xl shadow-brand/30 transition hover:scale-105"
            aria-label="Start playback"
          >
            <Play className="ml-1 h-7 w-7 fill-current" />
          </button>
          <p className="mt-3 text-sm text-slate-300">Your browser needs a click to start playback.</p>
        </Centered>
      );
    case 'error': {
      const failure = snapshot.failure;
      return (
        <Centered>
          <div className="max-w-md rounded-xl border border-white/10 bg-ink-900/90 p-5 text-center shadow-2xl backdrop-blur">
            <p className="font-medium text-white">{failure?.message ?? 'Playback failed.'}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {failure?.retryable && (
                <Button size="sm" variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry}>
                  Retry
                </Button>
              )}
              {failure?.externalUrl && (
                <a
                  href={failure.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/5 px-2.5 text-xs font-medium text-slate-100 ring-1 ring-inset ring-white/10 hover:bg-white/10"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open link
                </a>
              )}
              <Button size="sm" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={onNext}>
                Next channel
              </Button>
            </div>
            {failure && failure.details.length > 0 && (
              <details className="mt-4 text-left text-xs text-slate-400">
                <summary className="cursor-pointer select-none text-slate-300">Technical details</summary>
                <ul className="mt-2 space-y-1 font-mono">
                  {failure.details.map((line) => (
                    <li key={line} className="break-words">
                      {line}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Centered>
      );
    }
    default:
      return snapshot.mutedByAutoplayPolicy ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onUnmute();
          }}
          className="absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20 hover:bg-black/90"
        >
          <VolumeX className="h-4 w-4" /> Tap to unmute
        </button>
      ) : null;
  }
}

function progressLabel(snapshot: PlaybackSnapshot): string {
  if (snapshot.status === 'buffering') return 'Buffering…';
  if (snapshot.status === 'resolving') return 'Preparing stream…';
  const prefix = snapshot.status === 'reconnecting' ? 'Reconnecting' : 'Connecting';
  const attempt = snapshot.attempt;
  if (!attempt) return `${prefix}…`;
  const route = attempt.via === 'proxy' ? 'via ZIPTV proxy' : 'directly';
  return attempt.total > 1 ? `${prefix} ${route} (${attempt.index + 1}/${attempt.total})…` : `${prefix}…`;
}

function Centered({ children, passive = false }: { children: React.ReactNode; passive?: boolean }) {
  return (
    <div
      className={`absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 p-4 text-center ${passive ? 'pointer-events-none' : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
