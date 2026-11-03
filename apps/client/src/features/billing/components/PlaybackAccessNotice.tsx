import type { ConcurrencyLimitDetails } from '@ziptv/contracts';
import { CreditCard, MonitorSmartphone, Square } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../../lib/api-client';
import { accessNotice, type AccessFailure } from '../access-notice';
import { billingApi } from '../api';

/** The action buttons under an access notice (inside the player's error card). */
export function PlaybackAccessActions({ failure, onRetry }: { failure: AccessFailure; onRetry: () => void }) {
  const notice = accessNotice(failure);
  const [stopping, setStopping] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!notice) return null;

  if (notice.kind === 'subscribe') {
    return (
      <Link to="/plans" className={primaryClass}>
        <CreditCard className="h-3.5 w-3.5" aria-hidden /> See plans
      </Link>
    );
  }
  if (notice.kind === 'devices') {
    return (
      <Link to="/account#devices" className={primaryClass}>
        <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden /> Manage devices
      </Link>
    );
  }
  if (notice.kind !== 'concurrency') return null;

  const playing = ((failure.apiDetails ?? {}) as Partial<ConcurrencyLimitDetails>).playing ?? [];
  const stopOther = async (id: string) => {
    setStopping(id);
    setProblem(null);
    try {
      await billingApi.stopSession(id);
      onRetry();
    } catch (error) {
      setProblem(errorMessage(error));
      setStopping(null);
    }
  };
  return (
    <div className="w-full space-y-2 text-left">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Playing now</p>
      <ul className="space-y-1.5">
        {playing.map((item) => (
          <li key={item.playbackSessionId} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            <MonitorSmartphone className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm">{item.deviceName}</span>
            <button type="button" onClick={() => void stopOther(item.playbackSessionId)} disabled={stopping !== null} className={secondaryClass} aria-label={`Stop playback on ${item.deviceName} and watch here`}>
              <Square className="h-3 w-3 fill-current" aria-hidden /> {stopping === item.playbackSessionId ? 'Stopping…' : 'Stop & watch here'}
            </button>
          </li>
        ))}
      </ul>
      {problem && <p className="text-xs text-red-300">{problem}</p>}
      <Link to="/plans" className="block text-center text-xs text-white/60 underline-offset-2 hover:underline">
        Need more streams? See plans
      </Link>
    </div>
  );
}

const primaryClass = 'inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-2.5 text-xs font-medium text-white hover:bg-brand/90';
const secondaryClass = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15 disabled:opacity-50';
