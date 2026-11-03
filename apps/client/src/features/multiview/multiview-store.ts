import type { ContentRefDto } from '@ziptv/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistentStorage } from '../../lib/storage';

export const TILE_COUNT = 4;

export interface Tile {
  /** Live channel of a source, or a licensed channel. */
  content: Extract<ContentRefDto, { type: 'channel' } | { type: 'operator' }>;
  title: string;
}

interface MultiViewState {
  tiles: (Tile | null)[];
  /** The tile that is heard and takes the keyboard (others play muted). */
  focus: number;
  setTile: (index: number, tile: Tile | null) => void;
  setFocus: (index: number) => void;
}

/** Multi-view layout of this device (kept between visits). */
export const useMultiView = create<MultiViewState>()(
  persist(
    (set) => ({
      tiles: Array.from({ length: TILE_COUNT }, () => null),
      focus: 0,
      setTile: (index, tile) =>
        set((state) => {
          const tiles = [...state.tiles];
          tiles[index] = tile;
          return { tiles, ...(tile ? { focus: index } : {}) };
        }),
      setFocus: (focus) => set({ focus: Math.max(0, Math.min(TILE_COUNT - 1, focus)) }),
    }),
    { name: 'ziptv:multiview', storage: persistentStorage, version: 1 },
  ),
);

/** Tiles playing from one BYO source (its provider account may limit simultaneous streams). */
export function tilesOfSource(tiles: readonly (Tile | null)[], sourceId: string): number {
  return tiles.filter((tile) => tile?.content.type === 'channel' && tile.content.sourceId === sourceId).length;
}
