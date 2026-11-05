import type { AlternateStreamDto, ContentRefDto } from '@ziptv/contracts';
import { ArrowLeft, ExternalLink, LoaderCircle, Lock, Play, RefreshCw, Shuffle, SkipForward, Tv, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PROBLEMS } from '../../../lib/problems';
import { accessNotice } from '../../billing/access-notice';
import { PlaybackAccessActions } from '../../billing/components/PlaybackAccessNotice';
import type { PlaybackSnapshot } from '../playback-controller';
import { t } from '../../../i18n';

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
export function PlayerOverlay({ snapshot, hasContent, emptyLabel, onRetry, onNext, onBack, onAlternate, onUnlock, onStart, onUnmute, nextLabel, upNext, onReplay }: PlayerOverlayProps) {
  nextLabel ??= t('player.nextChannel');
  if (!hasContent) {
    return (
      <Centered>
        <Tv className="h-10 w-10 text-white/40" aria-hidden />
        <p className="mt-3 text-sm text-white/60">{emptyLabel ?? t('player.pickChannel')}</p>
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
            aria-label={t('player.overlay.start')}
          >
            <Play className="ml-1 h-7 w-7 fill-current" />
          </button>
          <p className="mt-3 text-sm text-white/80">{t('player.overlay.needsClick')}</p>
        </Centered>
      );
    case 'error': {
      const failure = snapshot.failure;
      const problem = failure?.problem ?? 'stream_unavailable';
      const notice = failure ? accessNotice(failure) : null;
      const copy = notice ?? PROBLEMS[problem];
      return (
        <Centered>
          <div className="max-w-md rounded-xl border border-white/10 bg-ink-900/90 p-5 text-center text-white shadow-2xl backdrop-blur" role="alert">
            {problem === 'parental_locked' && <Lock className="mx-auto mb-2 h-6 w-6 text-amber-300" aria-hidden />}
            <p className="text-base font-semibold">{copy.title}</p>
            <p className="mt-1 text-sm text-white/70">{notice || problem === 'stream_unavailable' || problem === 'parental_locked' ? copy.description : (failure?.message ?? copy.description)}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {notice && failure && <PlaybackAccessActions failure={failure} onRetry={onRetry} />}
              {problem === 'parental_locked' && onUnlock && (
                <OverlayButton primary icon={<Lock className="h-3.5 w-3.5" />} onClick={onUnlock}>
                  {t('player.overlay.enterPin')}
                </OverlayButton>
              )}
              {failure?.retryable && (
                <OverlayButton primary icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry}>
                  {t('player.overlay.retry')}
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
                  <ExternalLink className="h-3.5 w-3.5" /> {t('player.overlay.openLink')}
                </a>
              )}
              {onBack && (
                <OverlayButton icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onBack}>
                  {t('player.overlay.back')}
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
                <summary className="cursor-pointer select-none text-white/75">{t('player.overlay.details')}</summary>
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
              <p className="text-base font-semibold">{t('player.overlay.finished')}</p>
              {onReplay && (
                <OverlayButton primary icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onReplay}>
                  {t('player.overlay.again')}
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
          <VolumeX className="h-4 w-4" /> {t('player.overlay.unmute')}
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
        {t('player.overlay.upNext')}<span className="sr-only">: {upNext.title}</span>
      </p>
      <p className="mt-1 text-base font-semibold">{upNext.title}</p>
      {upNext.subtitle && <p className="text-sm text-white/70">{upNext.subtitle}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <OverlayButton primary icon={<Play className="h-3.5 w-3.5 fill-current" />} onClick={onNext}>
          {cancelled ? t('player.playNext') : t('player.playingIn', { seconds: left })}
        </OverlayButton>
        {!cancelled && (
          <OverlayButton icon={<X className="h-3.5 w-3.5" />} onClick={() => setCancelled(true)}>
            {t('player.cancel')}
          </OverlayButton>
        )}
        {cancelled && onReplay && (
          <OverlayButton icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onReplay}>
            {t('player.overlay.again')}
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
      {t('player.overlay.alternate')}
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
  if (snapshot.status === 'buffering') return t('player.overlay.buffering');
  if (snapshot.status === 'resolving') return t('player.overlay.preparing');
  const prefix = snapshot.status === 'reconnecting' ? t('player.reconnecting') : t('player.connecting');
  const attempt = snapshot.attempt;
  if (!attempt) return t('player.ellipsis', { prefix });
  const route = attempt.via === 'proxy' ? t('player.viaProxy') : t('player.directly');
  return attempt.total > 1 ? t('player.attempt', { prefix, route, index: attempt.index + 1, total: attempt.total }) : t('player.ellipsis', { prefix });
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
