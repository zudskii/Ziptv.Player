import { Check, Circle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { IconButton } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { useHelp } from './use-help';

/** Marked when Settings is opened (see SettingsPage). */
export const VISITED_SETTINGS = 'visited-settings';

export interface ChecklistProgress {
  hasSource: boolean;
  hasWatched: boolean;
}

/**
 * "Get started" on Home: the three things that make the app useful — a source, settings that fit
 * the person, and a first thing watched. Ticks itself off from what the profile has actually done;
 * hidden once everything is done or when dismissed (Settings → General brings it back).
 */
export function GetStartedChecklist({ hasSource, hasWatched }: ChecklistProgress) {
  const help = useHelp();
  if (!help.ready || help.checklistDismissed) return null;

  const steps: { id: string; done: boolean; title: string; to: string; action: string }[] = [
    { id: 'source', done: hasSource, title: t('help.checklist.source'), to: '/setup', action: t('help.checklist.sourceAction') },
    { id: 'settings', done: help.seen(VISITED_SETTINGS), title: t('help.checklist.settings'), to: '/settings', action: t('help.checklist.settingsAction') },
    { id: 'watch', done: hasWatched, title: t('help.checklist.watch'), to: '/live', action: t('help.checklist.watchAction') },
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;

  return (
    <section aria-labelledby="get-started-title" className="card relative p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="get-started-title" className="font-semibold text-fg">
            {t('help.checklist.title')}
          </h2>
          <p className="text-sm text-fg-muted">{t('help.checklist.progress', { done, total: steps.length })}</p>
        </div>
        <IconButton label={t('help.checklist.dismiss')} onClick={help.dismissChecklist} className="-mr-2 -mt-2">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <ProgressBar value={done / steps.length} label={t('help.checklist.title')} className="mt-3" />
      <ol className="mt-3 space-y-1">
        {steps.map((step) => (
          <Step key={step.id} done={step.done} action={step.done ? null : <Link to={step.to} className="shrink-0 text-sm font-medium text-brand-soft hover:underline">{step.action}</Link>}>
            {step.title}
          </Step>
        ))}
      </ol>
    </section>
  );
}

function Step({ done, action, children }: { done: boolean; action: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-lg px-1 py-1.5">
      {done ? <Check className="h-5 w-5 shrink-0 rounded-full bg-emerald-500/15 p-0.5 text-emerald-500" aria-hidden /> : <Circle className="h-5 w-5 shrink-0 text-fg-subtle" aria-hidden />}
      <span className={cn('min-w-0 flex-1 text-sm', done ? 'text-fg-muted line-through' : 'text-fg')}>
        {children}
        {done && <span className="sr-only"> — {t('help.checklist.doneStep')}</span>}
      </span>
      {action}
    </li>
  );
}
