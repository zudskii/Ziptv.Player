import type { ProfileDto } from '@ziptv/contracts';
import { Check, Users } from 'lucide-react';
import { Link } from 'react-router';

import { Popover } from '../../components/ui/Popover';
import { cn } from '../../lib/cn';
import { useActiveProfile, useProfiles } from './api';
import { useProfileStore } from './profile-store';

export function ProfileAvatar({ profile, className }: { profile: Pick<ProfileDto, 'name' | 'color' | 'kind'>; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className ?? 'h-7 w-7 text-xs')}
      style={{ backgroundColor: profile.color }}
      aria-hidden
    >
      {Array.from(profile.name)[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** Top-bar profile chooser (shown once the account has more than one profile, or to add one). */
export function ProfileSwitcher() {
  const profiles = useProfiles().data ?? [];
  const active = useActiveProfile();
  const select = useProfileStore((state) => state.select);
  if (!active) return null;
  return (
    <Popover
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Profile: ${active.name}`}
          className={cn('rounded-full p-1 transition hover:bg-fg/5', open && 'bg-fg/5')}
        >
          <ProfileAvatar profile={active} />
        </button>
      )}
      className="w-60 p-1.5"
    >
      {(close) => (
        <div role="menu" aria-label="Profiles">
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Who's watching?</p>
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="menuitemradio"
              aria-checked={profile.id === active.id}
              onClick={() => {
                select(profile.isDefault ? null : profile.id);
                close();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-fg/5"
            >
              <ProfileAvatar profile={profile} />
              <span className="min-w-0 flex-1 truncate">
                {profile.name}
                {profile.kind === 'kids' && <span className="ml-1.5 text-xs text-fg-subtle">Kids</span>}
              </span>
              {profile.id === active.id && <Check className="h-4 w-4 text-brand-soft" />}
            </button>
          ))}
          <div className="my-1 border-t border-line/5" />
          <Link to="/settings#profiles" onClick={close} role="menuitem" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-fg/5 hover:text-fg">
            <Users className="h-4 w-4" /> Manage profiles
          </Link>
        </div>
      )}
    </Popover>
  );
}
