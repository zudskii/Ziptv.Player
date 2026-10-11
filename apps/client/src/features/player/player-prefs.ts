import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistentStorage } from '../../lib/storage';

interface PlayerPrefsState {
  /** Last source opened in Live TV. */
  activeSourceId: string | null;
  volume: number;
  muted: boolean;
  /** Last watched channel per source, used to resume. */
  lastChannel: Record<string, string>;
  setActiveSource: (sourceId: string | null) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  rememberChannel: (sourceId: string, channelKey: string) => void;
}

export const usePlayerPrefs = create<PlayerPrefsState>()(
  persist(
    (set) => ({
      activeSourceId: null,
      volume: 1,
      muted: false,
      lastChannel: {},
      setActiveSource: (activeSourceId) => set({ activeSourceId }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setMuted: (muted) => set({ muted }),
      rememberChannel: (sourceId, channelKey) => set((state) => ({ lastChannel: { ...state.lastChannel, [sourceId]: channelKey } })),
    }),
    {
      name: 'ziptv:player',
      storage: persistentStorage,
      version: 2,
      // 2.x stored the active *playlist*; playlists became sources with the same id.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2 && 'activePlaylistId' in state) {
          state.activeSourceId = state.activePlaylistId;
          delete state.activePlaylistId;
        }
        return state as unknown as PlayerPrefsState;
      },
    },
  ),
);
