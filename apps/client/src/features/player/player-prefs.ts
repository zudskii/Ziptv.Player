import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistentStorage } from '../../lib/storage';

interface PlayerPrefsState {
  activePlaylistId: string | null;
  volume: number;
  muted: boolean;
  /** Last watched channel per playlist, used to resume. */
  lastChannel: Record<string, string>;
  setActivePlaylist: (playlistId: string | null) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  rememberChannel: (playlistId: string, channelKey: string) => void;
}

export const usePlayerPrefs = create<PlayerPrefsState>()(
  persist(
    (set) => ({
      activePlaylistId: null,
      volume: 1,
      muted: false,
      lastChannel: {},
      setActivePlaylist: (activePlaylistId) => set({ activePlaylistId }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setMuted: (muted) => set({ muted }),
      rememberChannel: (playlistId, channelKey) =>
        set((state) => ({ lastChannel: { ...state.lastChannel, [playlistId]: channelKey } })),
    }),
    { name: 'ziptv:player', storage: persistentStorage, version: 1 },
  ),
);
