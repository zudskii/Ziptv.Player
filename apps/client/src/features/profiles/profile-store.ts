import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { configureContextHeaders, configureProfileRecovery } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { persistentStorage } from '../../lib/storage';

interface ProfileState {
  /** null = the account's default profile. */
  profileId: string | null;
  select: (profileId: string | null) => void;
}

/** The active profile of this device; sent as `X-Profile-Id` with every API call. */
export const useProfileStore = create<ProfileState>()(
  persist(
    (set, get) => ({
      profileId: null,
      select: (profileId) => {
        if (get().profileId === profileId) return;
        set({ profileId });
        // Everything cached belongs to the previous profile (lists, progress, home, settings):
        // reset (not just clear) so mounted screens refetch right away as the new profile.
        void queryClient.resetQueries();
      },
    }),
    { name: 'ziptv:profile', storage: persistentStorage, version: 1 },
  ),
);

/** A new identity (sign in / sign out) starts on its default profile. */
export function resetProfileSelection(): void {
  useProfileStore.setState({ profileId: null });
}

export function installProfileHeaders(): void {
  configureContextHeaders((): Record<string, string> => {
    const profileId = useProfileStore.getState().profileId;
    return profileId ? { 'X-Profile-Id': profileId } : {};
  });
  configureProfileRecovery(() => {
    if (!useProfileStore.getState().profileId) return false;
    useProfileStore.getState().select(null);
    return true;
  });
}
