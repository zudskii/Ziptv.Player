import type { SourceDto } from '@ziptv/contracts';
import { Check, LoaderCircle } from 'lucide-react';

import { cn } from '../../../lib/cn';
import { stageIndex, SYNC_STAGES } from '../source-status';

/** "Connecting… → Parsing channels… → Matching EPG… → Building your library…" */
export function SyncProgress({ source, className }: { source: Pick<SourceDto, 'sync' | 'revision'>; className?: string }) {
  const finished = source.sync.status === 'idle' && source.revision > 0;
  const current = source.sync.status === 'running' ? Math.max(0, stageIndex(source.sync.stage)) : source.sync.status === 'queued' ? 0 : -1;

  return (
    <ol className={cn('space-y-2.5', className)} aria-label="Sync progress">
      {SYNC_STAGES.map((step, index) => {
        const done = finished || index < current;
        const active = !finished && index === current && source.sync.status !== 'failed';
        return (
          <li key={step.stage} className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                done ? 'bg-emerald-500/15 text-emerald-500 ring-emerald-500/30' : active ? 'bg-brand/15 text-brand-soft ring-brand/40' : 'text-fg-subtle ring-line/10',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : active ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <span className={cn(done ? 'text-fg' : active ? 'font-medium text-fg' : 'text-fg-subtle')}>{step.label.replace('…', done ? '' : '…')}</span>
          </li>
        );
      })}
    </ol>
  );
}
