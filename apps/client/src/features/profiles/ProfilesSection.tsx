import type { ProfileDto, ProfileKind } from '@ziptv/contracts';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button, IconButton } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog } from '../../components/ui/Dialog';
import { Segmented } from '../../components/ui/Segmented';
import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { useActiveProfile, useCreateProfile, useDeleteProfile, useProfiles, useUpdateProfile } from './api';
import { ProfileAvatar } from './ProfileSwitcher';
import { isPinRequired, useParental } from '../parental/api';
import { askPin } from '../parental/pin-prompt';
import { Switch } from '../../components/ui/Switch';
import { t } from '../../i18n';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#64748b'];
const MAX_PROFILES = 5;

/** Settings → Profiles: My List, history, progress and settings are separate per profile. */
export function ProfilesSection() {
  const profiles = useProfiles().data ?? [];
  const active = useActiveProfile();
  const [editing, setEditing] = useState<ProfileDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ProfileDto | null>(null);
  const remove = useDeleteProfile();

  return (
    <section id="profiles" className="card space-y-3 p-4" aria-labelledby="profiles-title">
      <div className="flex items-center gap-2">
        <h2 id="profiles-title" className="flex-1 font-semibold text-fg">
          {t('profiles.title')}
        </h2>
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')} disabled={profiles.length >= MAX_PROFILES}>
          {t('profiles.add')}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">{t('profiles.intro')}</p>
      <ul className="divide-y divide-line/5">
        {profiles.map((profile) => (
          <li key={profile.id} className="flex items-center gap-3 py-2">
            <ProfileAvatar profile={profile} className="h-9 w-9 text-sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{profile.name}</span>
              <span className="block text-xs text-fg-subtle">
                {[profile.isDefault ? t('profiles.main') : null, profile.kind === 'kids' ? t('profiles.kids') : t('profiles.standard'), profile.pinProtected ? t('profiles.pinProtected') : null, profile.id === active?.id ? t('profiles.activeHere') : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <IconButton label={t('profiles.editNamed', { name: profile.name })} onClick={() => setEditing(profile)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            {!profile.isDefault && (
              <IconButton label={t('profiles.deleteNamed', { name: profile.name })} onClick={() => setDeleting(profile)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      <ProfileDialog profile={editing} onClose={() => setEditing(null)} usedColors={profiles.map((profile) => profile.color)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('profiles.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('profiles.deleteHint')}
        confirmLabel={t('profiles.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync({ id: deleting.id });
          } catch (failure) {
            if (!isPinRequired(failure)) throw failure;
            if (!(await askPin({ title: t('profiles.enterPin'), description: t('profiles.deleteNeedsPin'), verify: async (pin) => void (await remove.mutateAsync({ id: deleting.id, pin })) }))) return;
          }
          toast.success(t('profiles.deleted', { name: deleting.name }));
        }}
      />
    </section>
  );
}

function ProfileDialog({ profile, onClose, usedColors }: { profile: ProfileDto | 'new' | null; onClose: () => void; usedColors: string[] }) {
  return (
    <Dialog open={profile !== null} onClose={onClose} title={profile === 'new' ? t('profiles.new') : t('profiles.edit')} className="w-[min(94vw,26rem)]">
      {profile !== null && <ProfileForm key={profile === 'new' ? 'new' : profile.id} profile={profile === 'new' ? null : profile} onClose={onClose} usedColors={usedColors} />}
    </Dialog>
  );
}

function ProfileForm({ profile, onClose, usedColors }: { profile: ProfileDto | null; onClose: () => void; usedColors: string[] }) {
  const id = useId();
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const [name, setName] = useState(profile?.name ?? '');
  const [kind, setKind] = useState<ProfileKind>(profile?.kind ?? 'standard');
  const [color, setColor] = useState(profile?.color ?? COLORS.find((value) => !usedColors.includes(value)) ?? COLORS[0]!);
  const [pinProtected, setPinProtected] = useState(profile?.pinProtected ?? false);
  const pinSet = useParental().data?.pinSet ?? false;
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const patch = { name, kind, color, ...(pinSet ? { pinProtected } : {}) };
      // Changing who a profile is for (kind, PIN protection) needs the parental PIN once one is set.
      const save = (pin?: string) => (profile ? update.mutateAsync({ id: profile.id, patch: { ...patch, ...(pin ? { pin } : {}) } }) : create.mutateAsync({ ...patch, ...(pin ? { pin } : {}) }));
      try {
        await save();
      } catch (failure) {
        if (!isPinRequired(failure)) throw failure;
        if (!(await askPin({ title: t('profiles.enterPin'), description: t('profiles.editNeedsPin'), verify: async (pin) => void (await save(pin)) }))) return;
      }
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-sm text-fg-muted">
          {t('profiles.name')}
        </label>
        <input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={30} required className="field" autoFocus />
      </div>
      <Segmented<ProfileKind>
        label={t('profiles.type')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'standard', label: t('profiles.standard') },
          { value: 'kids', label: t('profiles.kids') },
        ]}
      />
      {pinSet && (
        <Switch checked={pinProtected} onChange={setPinProtected} label={t('profiles.requirePin')} description={t('profiles.requirePinHint')} />
      )}
      <fieldset>
        <legend className="mb-1.5 text-sm text-fg-muted">{t('profiles.colour')}</legend>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={t('profiles.colourNamed', { value })}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
              className={cn('h-8 w-8 rounded-full ring-offset-2 ring-offset-surface', color === value && 'ring-2 ring-fg')}
              style={{ backgroundColor: value }}
            />
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('profiles.cancel')}</Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
          {profile ? t('profiles.save') : t('profiles.create')}
        </Button>
      </div>
    </form>
  );
}
