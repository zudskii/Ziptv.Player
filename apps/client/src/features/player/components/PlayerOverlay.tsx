import type { AlternateStreamDto, ContentRefDto } from '@ziptv/contracts';
import { ArrowLeft, ExternalLink, LoaderCircle, Lock, Play, RefreshCw, Shuffle, SkipForward, Tv, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PROBLEMS } from '../../../lib/problems';
import type { PlaybackSnapshot } from '../playback-controller';

interface PlayerOverlayProps {
  snapshot: PlaybackSnapshot;
  hasContent: boolean;
  emptyLabel?: string;
  onRetry: () => void;
  onNext?: () => void;
  onBack?: () => void;
  onAlternate?: (ref: ContentRefDto) => void;
  onUnlock?: () => void;
  onStart: () => void;
  onUnmute: () => void;
  nextLabel?: string;
  upNext?: { title: string; subtitle: string | null; autoplay: boolean } | null;
  onReplay?: () => void;
}

/** Everything drawn on top of the video: empty state, progress, autoplay prompts and error screens. */
export function PlayerOverlay({ snapshot, hasContent, emptyLabel, onRetry, onNext, onBack, onAlternate, onUnlock, onStart, onUnmute, nextLabel = 'Next channel', upNext, onReplay }: PlayerOverlayProps) {
  if (!hasContent) {
    return (
      <Centered>
        <Tv className="h-10 w-10 text-white/40" aria-hidden />
        <p className="mt-3 text-sm text-white/60">{emptyLabel ?? 'Pick a channel from the list to start watching.'}</p>
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
          <p className="mt-3 rounded-full bg-black/50 px-3 py-1 text-xs text-white/85" role="status">
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
          <p className="mt-3 text-sm text-white/80">Your browser needs a click to start playback.</p>
        </Centered>
      );
    case 'error': {
      const failure = snapshot.failure;
      const problem = failure?.problem ?? 'stream_unavailable';
      const copy = PROBLEMS[problem];
      return (
        <Centered>
          <div className="max-w-md rounded-xl border border-white/10 bg-ink-900/90 p-5 text-center text-white shadow-2xl backdrop-blur" role="alert">
            {problem === 'parental_locked' && <Lock className="mx-auto mb-2 h-6 w-6 text-amber-300" aria-hidden />}
            <p className="text-base font-semibold">{copy.title}</p>
            <p className="mt-1 text-sm text-white/70">{problem === 'stream_unavailable' || problem === 'parental_locked' ? copy.description : (failure?.message ?? copy.description)}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {problem === 'parental_locked' && onUnlock && (
                <OverlayButton primary icon={<Lock className="h-3.5 w-3.5" />} onClick={onUnlock}>
                  Enter PIN
                </OverlayButton>
              )}
              {failure?.retryable && (
                <OverlayButton primary icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry}>
                  Retry
                </OverlayButton>
              )}
              {onAlternate && failure && failure.alternates.length > 0 && <AlternateButton alternates={failure.alternates} onAlternate={onAlternate} />}
              {failure?.externalUrl && (
                <a
                  href={failure.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open link
                </a>
              )}
              {onBack && (
                <OverlayButton icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onBack}>
                  Back to channels
                </OverlayButton>
              )}
              {onNext && (
                <OverlayButton icon={<SkipForward className="h-3.5 w-3.5" />} onClick={onNext}>
                  {nextLabel}
                </OverlayButton>
              )}
            </div>
            {failure && failure.details.length > 0 && (
              <details className="mt-4 text-left text-xs text-white/60">
                <summary className="cursor-pointer select-none text-white/75">Technical details</summary>
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
    case 'ended':
      return (
        <Centered>
          {upNext && onNext ? (
            <UpNext upNext={upNext} onNext={onNext} onReplay={onReplay} />
          ) : (
            <div className="flex flex-col items-center gap-3 text-white">
              <p className="text-base font-semibold">Finished</p>
              {onReplay && (
                <OverlayButton primary icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onReplay}>
                  Watch again
                </OverlayButton>
              )}
            </div>
          )}
        </Centered>
      );
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

const AUTOPLAY_SECONDS = 8;

/** End of an episode: the next one, with an autoplay countdown when enabled in Settings. */
function UpNext({ upNext, onNext, onReplay }: { upNext: NonNullable<PlayerOverlayProps['upNext']>; onNext: () => void; onReplay?: () => void }) {
  const [left, setLeft] = useState(AUTOPLAY_SECONDS);
  const [cancelled, setCancelled] = useState(!upNext.autoplay);
  // Fire exactly once: the parent's onNext changes identity after navigating, and must not
  // be called again for the episode after next.
  const fired = useRef(false);
  const next = useRef(onNext);
  useEffect(() => {
    next.current = onNext;
  });
  useEffect(() => {
    if (cancelled || fired.current) return;
    if (left <= 0) {
      fired.current = true;
      next.current();
      return;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, cancelled]);
  return (
    <div className="max-w-sm rounded-xl border border-white/10 bg-ink-900/90 p-5 text-left text-white shadow-2xl backdrop-blur">
      {/* Static live region: the ticking countdown (button text) is not announced every second. */}
      <p className="text-xs font-semibold uppercase tracking-wide text-white/60" role="status">
        Up next<span className="sr-only">: {upNext.title}</span>
      </p>
      <p className="mt-1 text-base font-semibold">{upNext.title}</p>
      {upNext.subtitle && <p className="text-sm text-white/70">{upNext.subtitle}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <OverlayButton primary icon={<Play className="h-3.5 w-3.5 fill-current" />} onClick={onNext}>
          {cancelled ? 'Play next episode' : `Playing in ${left}s`}
        </OverlayButton>
        {!cancelled && (
          <OverlayButton icon={<X className="h-3.5 w-3.5" />} onClick={() => setCancelled(true)}>
            Cancel
          </OverlayButton>
        )}
        {cancelled && onReplay && (
          <OverlayButton icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onReplay}>
            Watch again
          </OverlayButton>
        )}
      </div>
    </div>
  );
}

function AlternateButton({ alternates, onAlternate }: { alternates: AlternateStreamDto[]; onAlternate: (ref: ContentRefDto) => void }) {
  const first = alternates[0]!;
  return (
    <OverlayButton icon={<Shuffle className="h-3.5 w-3.5" />} onClick={() => onAlternate(first.ref)} title={`${first.name} · ${first.sourceName}`}>
      Try alternate stream
    </OverlayButton>
  );
}

function OverlayButton({ children, icon, onClick, primary, title }: { children: ReactNode; icon: ReactNode; onClick: () => void; primary?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        primary
          ? 'inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-2.5 text-xs font-medium text-white hover:bg-brand-strong'
          : 'inline-flex h-8 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15'
      }
    >
      {icon}
      {children}
    </button>
  );
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

function Centered({ children, passive = false }: { children: ReactNode; passive?: boolean }) {
  return (
    <div
      className={`absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 p-4 text-center ${passive ? 'pointer-events-none' : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
