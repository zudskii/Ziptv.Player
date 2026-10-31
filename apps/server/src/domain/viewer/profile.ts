/** Profiles of one account (My List, history, progress and settings are per profile). */

export type ProfileKind = 'standard' | 'kids';

export const MAX_PROFILES = 5;
export const PROFILE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#64748b'] as const;
export const DEFAULT_PROFILE_NAME = 'Me';
const COLOR = /^#[0-9a-f]{6}$/i;

export function isProfileColor(value: string): boolean {
  return COLOR.test(value);
}

/** Next unused palette colour (new profiles look different without asking). */
export function nextProfileColor(used: readonly string[]): string {
  const taken = new Set(used.map((color) => color.toLowerCase()));
  return PROFILE_COLORS.find((color) => !taken.has(color)) ?? PROFILE_COLORS[used.length % PROFILE_COLORS.length]!;
}

export function normalizeProfileName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 30);
}
