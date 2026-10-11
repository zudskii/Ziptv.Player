import type { CatchupInfo, CatchupMode } from './model.js';

const MAX_DAYS = 30;

const MODE_ALIASES: Record<string, CatchupMode> = {
  default: 'default',
  append: 'append',
  shift: 'shift',
  timeshift: 'shift',
  flussonic: 'flussonic',
  'flussonic-hls': 'flussonic',
  'flussonic-ts': 'flussonic',
  fs: 'flussonic',
  xc: 'xtream',
  xtream: 'xtream',
};

/**
 * Reads archive support from M3U attributes (TiviMate / Kodi / OTT Navigator conventions):
 *   catchup="default|append|shift|flussonic|xc"  catchup-days="7"  catchup-source="…"
 *   timeshift="7" / tvg-rec="7"  (days, implies shift mode)
 * `defaults` are the same attributes declared once on the `#EXTM3U` header.
 */
export function parseCatchup(attributes: Record<string, string>, defaults: Record<string, string> = {}): CatchupInfo | null {
  const read = (name: string): string | undefined => {
    const own = attributes[name]?.trim();
    return own ? own : defaults[name]?.trim() || undefined;
  };

  const rawMode = read('catchup')?.toLowerCase();
  const days = toDays(read('catchup-days')) ?? toDays(read('timeshift')) ?? toDays(read('tvg-rec'));
  const template = read('catchup-source') ?? null;

  if (!rawMode && days === null) return null;
  if (rawMode === 'disabled' || rawMode === 'none' || rawMode === '0') return null;

  const mode: CatchupMode = (rawMode ? MODE_ALIASES[rawMode] : undefined) ?? (template ? 'default' : 'shift');
  if (mode === 'default' && !template) {
    // "default" without a template is meaningless; most players fall back to shift.
    return { mode: 'shift', days: days ?? 1, template: null };
  }
  return { mode, days: days ?? 1, template };
}

function toDays(value: string | undefined): number | null {
  if (!value) return null;
  const days = Number.parseFloat(value);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.min(MAX_DAYS, Math.ceil(days));
}
