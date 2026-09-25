import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistentStorage } from '../../lib/storage';

const MAX_RECENTS = 30;

/**
 * Per-device favourites and watch history, keyed by playlist id → channel key.
 * Channel keys are stable across playlist refreshes, so these survive provider token rotation.
 */
interface LibraryState {
  favorites: Record<string, string[]>;
  recents: Record<string, string[]>;
  toggleFavorite: (playlistId: string, channelKey: string) => void;
  pushRecent: (playlistId: string, channelKey: string) => void;
  forgetPlaylist: (playlistId: string) => void;
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      favorites: {},
      recents: {},
      toggleFavorite: (playlistId, channelKey) =>
        set((state) => {
          const current = state.favorites[playlistId] ?? [];
          const next = current.includes(channelKey) ? current.filter((key) => key !== channelKey) : [...current, channelKey];
          return { favorites: { ...state.favorites, [playlistId]: next } };
        }),
      pushRecent: (playlistId, channelKey) =>
        set((state) => {
          const current = state.recents[playlistId] ?? [];
          if (current[0] === channelKey) return state;
          const next = [channelKey, ...current.filter((key) => key !== channelKey)].slice(0, MAX_RECENTS);
          return { recents: { ...state.recents, [playlistId]: next } };
        }),
      forgetPlaylist: (playlistId) =>
        set((state) => {
          const favorites = { ...state.favorites };
          const recents = { ...state.recents };
          delete favorites[playlistId];
          delete recents[playlistId];
          return { favorites, recents };
        }),
    }),
    { name: 'ziptv:library', storage: persistentStorage, version: 1 },
  ),
);

const EMPTY: string[] = [];

export function useFavorites(playlistId: string | undefined): string[] {
  return useLibraryStore((state) => (playlistId ? (state.favorites[playlistId] ?? EMPTY) : EMPTY));
}

export function useRecents(playlistId: string | undefined): string[] {
  return useLibraryStore((state) => (playlistId ? (state.recents[playlistId] ?? EMPTY) : EMPTY));
}
