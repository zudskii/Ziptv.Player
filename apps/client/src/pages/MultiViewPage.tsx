import { LayoutGrid, Plus, Repeat2, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { IconButton } from '../components/ui/Button';
import { ChannelPicker } from '../features/multiview/ChannelPicker';
import { TILE_COUNT, tilesOfSource, useMultiView, type Tile } from '../features/multiview/multiview-store';
import { VideoPlayer } from '../features/player/components/VideoPlayer';
import { cn } from '../lib/cn';

/**
 * /multiview — up to four channels at once (2×2). Each tile is a full player of its own: licensed
 * channels each hold one of the plan's stream slots (playback session), and channels of the
 * viewer's own Xtream accounts one of the account's connections — the server refuses a tile over
 * the limit like any other player. Only the focused tile is heard and takes the keyboard.
 */
export function MultiViewPage() {
  const tiles = useMultiView((state) => state.tiles);
  const focus = useMultiView((state) => state.focus);
  const setTile = useMultiView((state) => state.setTile);
  const setFocus = useMultiView((state) => state.setFocus);
  const [picking, setPicking] = useState<number | null>(null);

  // 1–4 move the focus (and the sound) between tiles; the focused player handles the rest.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (!/^[1-4]$/.test(event.key)) return;
      setFocus(Number(event.key) - 1);
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [setFocus]);

  const used = tiles.filter(Boolean).length;
  return (
    <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-3 p-3 sm:p-5">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold text-fg">
          <LayoutGrid className="h-5 w-5 text-brand-soft" /> Multi-view
        </h1>
        <p className="text-sm text-fg-muted">
          {used}/{TILE_COUNT} playing · press <kbd className="rounded border border-line/10 bg-fg/5 px-1 font-mono text-[11px]">1</kbd>–<kbd className="rounded border border-line/10 bg-fg/5 px-1 font-mono text-[11px]">4</kbd> or click a tile to hear it
        </p>
      </header>
      <div className="grid gap-2 sm:grid-cols-2" role="list" aria-label="Tiles">
        {tiles.map((tile, index) => (
          <TileView
            key={index}
            index={index}
            tile={tile}
            focused={focus === index}
            onFocus={() => setFocus(index)}
            onPick={() => setPicking(index)}
            onRemove={() => setTile(index, null)}
          />
        ))}
      </div>
      <ChannelPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        usage={(sourceId) => tilesOfSource(tiles.filter((_, index) => index !== picking), sourceId)}
        onPick={(tile) => {
          if (picking !== null) setTile(picking, tile);
          setPicking(null);
        }}
      />
    </div>
  );
}

interface TileViewProps {
  index: number;
  tile: Tile | null;
  focused: boolean;
  onFocus: () => void;
  onPick: () => void;
  onRemove: () => void;
}

function TileView({ index, tile, focused, onFocus, onPick, onRemove }: TileViewProps) {
  return (
    <div
      role="listitem"
      aria-label={`Tile ${index + 1}${tile ? `: ${tile.title}` : ''}${focused ? ' (sound)' : ''}`}
      className={cn('relative rounded-xl ring-2 transition', focused ? 'ring-brand' : 'ring-transparent')}
    >
      {tile ? (
        <>
          {/* The first click on another tile only moves the focus (and the sound) there. One player
              per tile: changing its channel moves its stream slot along (no second connection). */}
          <div
            onClickCapture={(event) => {
              if (focused) return;
              event.stopPropagation();
              onFocus();
            }}
          >
            <VideoPlayer content={tile.content} title={tile.title} shortcuts={focused} audioFocus={focused} className="rounded-xl" />
          </div>
          <div className="absolute left-2 top-2 z-30 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-lg bg-black/60 py-0.5 pl-2 pr-0.5 text-xs text-white backdrop-blur">
            <span className="tabular-nums text-white/60">{index + 1}</span>
            {focused ? <Volume2 className="h-3.5 w-3.5 text-brand-soft" aria-label="Sound" /> : <VolumeX className="h-3.5 w-3.5 text-white/50" aria-label="Muted" />}
            <span className="min-w-0 truncate font-medium">{tile.title}</span>
            <IconButton tone="onDark" label={`Change tile ${index + 1}`} onClick={onPick} className="h-7 w-7">
              <Repeat2 className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton tone="onDark" label={`Close tile ${index + 1}`} onClick={onRemove} className="h-7 w-7">
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={onPick}
          className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line/15 bg-sunken/40 text-sm text-fg-muted hover:bg-fg/5 hover:text-fg"
        >
          <Plus className="h-6 w-6" /> Add a channel
        </button>
      )}
    </div>
  );
}
