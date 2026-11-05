import type { ProfileDto, SourceDto } from '@ziptv/contracts';
import { Server } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { t } from '../../i18n';
import { errorMessage } from '../../lib/api-client';
import { isPinRequired } from '../parental/api';
import { askPin } from '../parental/pin-prompt';
import { useAccountSources } from '../sources/api';
import { useProfileLibrary, useSetProfileLibrary } from './api';

/**
 * Profile → Library: which of the account's sources this profile sees. Sources are not copied —
 * the same source can be in several libraries, and its credentials and connection limit stay one.
 */
export function LibraryEditor({ profile, onDone }: { profile: ProfileDto; onDone: () => void }) {
  const sources = useAccountSources();
  const library = useProfileLibrary(profile.id);
  if (sources.isPending || library.isPending) return <Spinner className="py-8" label={t('library.loading')} />;
  if (sources.isError || library.isError) return <EmptyState tone="error" title={t('library.loadFailed')} description={errorMessage(sources.error ?? library.error)} onRetry={() => void Promise.all([sources.refetch(), library.refetch()])} />;
  return <LibraryForm key={profile.id} profile={profile} sources={sources.data} initial={library.data.sourceIds} onDone={onDone} />;
}

function LibraryForm({ profile, sources, initial, onDone }: { profile: ProfileDto; sources: SourceDto[]; initial: string[]; onDone: () => void }) {
  const [selected, setSelected] = useState(() => new Set(initial));
  const [error, setError] = useState<string | null>(null);
  const save = useSetProfileLibrary();
  const changed = selected.size !== initial.length || initial.some((id) => !selected.has(id));

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={<Server className="h-8 w-8" />}
        title={t('library.noSources')}
        description={t('library.noSourcesHint')}
        action={
          <ButtonLink to="/sources" size="sm" variant="primary">
            {t('library.manageSources')}
          </ButtonLink>
        }
      />
    );
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setError(null);
    const sourceIds = sources.filter((source) => selected.has(source.id)).map((source) => source.id);
    const run = (pin?: string) => save.mutateAsync({ id: profile.id, sourceIds, ...(pin ? { pin } : {}) });
    try {
      try {
        await run();
      } catch (failure) {
        // Kids profiles: only a grown-up (the PIN) decides what they can watch.
        if (!isPinRequired(failure)) throw failure;
        if (!(await askPin({ title: t('profiles.enterPin'), description: t('library.needsPin'), verify: async (pin) => void (await run(pin)) }))) return;
      }
      toast.success(t('library.saved', { name: profile.name }));
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">{profile.kind === 'kids' ? t('library.introKids', { name: profile.name }) : t('library.intro', { name: profile.name })}</p>
      <fieldset>
        <legend className="sr-only">{t('library.sources')}</legend>
        <ul className="max-h-72 divide-y divide-line/5 overflow-y-auto rounded-lg border border-line/10">
          {sources.map((source) => (
            <li key={source.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-fg/5">
                <input type="checkbox" checked={selected.has(source.id)} onChange={() => toggle(source.id)} className="h-4 w-4 accent-brand" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{source.name}</span>
                  <span className="block text-xs text-fg-subtle">{t('library.counts', { live: source.stats.live, movies: source.stats.movies, series: source.stats.series })}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="text-xs text-fg-subtle">{t('library.selected', { count: selected.size, total: sources.length })}</p>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t('profiles.cancel')}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!changed} onClick={() => void submit()}>
          {t('profiles.save')}
        </Button>
      </div>
    </div>
  );
}
