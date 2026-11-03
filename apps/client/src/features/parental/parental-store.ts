import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { tabStorage } from '../../lib/storage';

interface Unlock {
  token: string;
  /** ms since epoch. */
  expiresAt: number;
}

interface ParentalState {
  /**
   * Unlock tokens by profile (`default` = the account's default profile). Kept for this tab only
   * (a reload keeps them, a new tab or a closed browser asks again); the server bounds them to this
   * device, profile and PIN, and to a few minutes.
   */
  unlocks: Record<string, Unlock>;
  setUnlock: (profileKey: string, unlock: Unlock) => void;
  clear: () => void;
}

export const useParentalStore = create<ParentalState>()(
  persist(
    (set) => ({
      unlocks: {},
      setUnlock: (profileKey, unlock) => set((state) => ({ unlocks: { ...state.unlocks, [profileKey]: unlock } })),
      clear: () => set({ unlocks: {} }),
    }),
    { name: 'ziptv:unlocks', storage: tabStorage, version: 1 },
  ),
);

export const profileKey = (profileId: string | null) => profileId ?? 'default';

/** The valid unlock token of a profile, if any. */
export function unlockTokenFor(profileId: string | null, now = Date.now()): string | null {
  const unlock = useParentalStore.getState().unlocks[profileKey(profileId)];
  return unlock && unlock.expiresAt > now + 5_000 ? unlock.token : null;
}
