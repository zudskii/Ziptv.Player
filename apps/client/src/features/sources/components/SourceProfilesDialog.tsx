import type { ProfileDto, SourceDto } from '@ziptv/contracts';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { t } from '../../../i18n';
import { errorMessage } from '../../../lib/api-client';
import { isPinRequired } from '../../parental/api';
import { askPin } from '../../parental/pin-prompt';
import { useProfiles } from '../../profiles/api';
import { ProfileAvatar } from '../../profiles/ProfileSwitcher';
import { useSetSourceProfiles } from '../api';

/** Settings → Sources → "Who sees it": the profiles whose library has this source. */
export function SourceProfilesDialog({ source, onClose }: { source: SourceDto | null; onClose: () => void }) {
  const profiles = useProfiles().data ?? [];
  return (
    <Dialog open={source !== null} onClose={onClose} title={t('library.whoSees')} description={source ? t('library.whoSeesHint', { name: source.name }) : undefined} className="w-[min(94vw,26rem)]">
      {source && <ProfilesForm key={source.id} source={source} profiles={profiles} onClose={onClose} />}
    </Dialog>
  );
}

function ProfilesForm({ source, profiles, onClose }: { source: SourceDto; profiles: ProfileDto[]; onClose: () => void }) {
  const [selected, setSelected] = useState(() => new Set(source.profileIds));
  const [error, setError] = useState<string | null>(null);
  const save = useSetSourceProfiles();
  const changed = selected.size !== source.profileIds.length || source.profileIds.some((id) => !selected.has(id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setError(null);
    const profileIds = profiles.filter((profile) => selected.has(profile.id)).map((profile) => profile.id);
    const run = (pin?: string) => save.mutateAsync({ id: source.id, profileIds, ...(pin ? { pin } : {}) });
    try {
      try {
        await run();
      } catch (failure) {
        if (!isPinRequired(failure)) throw failure;
        if (!(await askPin({ title: t('profiles.enterPin'), description: t('library.needsPin'), verify: async (pin) => void (await run(pin)) }))) return;
      }
      toast.success(t('library.sharingSaved', { name: source.name }));
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">{t('library.profiles')}</legend>
        <ul className="divide-y divide-line/5 rounded-lg border border-line/10">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-fg/5">
                <input type="checkbox" checked={selected.has(profile.id)} onChange={() => toggle(profile.id)} className="h-4 w-4 accent-brand" />
                <ProfileAvatar profile={profile} className="h-7 w-7 text-xs" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{profile.name}</span>
                {profile.kind === 'kids' && <span className="text-xs text-fg-subtle">{t('profiles.kids')}</span>}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {selected.size === 0 && <p className="text-xs text-amber-500">{t('library.nobody')}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('profiles.cancel')}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!changed} onClick={() => void submit()}>
          {t('profiles.save')}
        </Button>
      </div>
    </div>
  );
}
