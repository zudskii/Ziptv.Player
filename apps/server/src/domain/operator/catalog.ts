import { normalizeChannelName } from '../shared/text.js';

/**
 * Operator master catalog (pure rules): device classes, business models, territories,
 * dedup keys and lineups. One master channel can be fed by several providers' streams.
 */

export const DEVICE_CLASSES = ['web', 'mobile', 'tv', 'stb'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const BUSINESS_MODELS = ['subscription', 'fast', 'b2b'] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export const PROVIDER_TYPES = ['m3u', 'xtream', 'mock'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];
export type ProviderStatus = 'active' | 'paused' | 'terminated';

export type StreamStatus = 'pending' | 'matched' | 'ignored' | 'gone';
export type MatchMethod = 'tvg_id' | 'name' | 'manual';
export type AliasKind = 'name' | 'tvg_id' | 'manual';

/** ISO 3166-1 alpha-2 (format check; the operator decides which markets exist). */
export function isCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value);
}

export function isTerritory(value: string): boolean {
  return value === '*' || isCountryCode(value);
}

/** ISO 639-1/2 language code. */
export function isLanguageCode(value: string): boolean {
  return /^[a-z]{2,3}$/.test(value);
}

/** URL-safe identifier: "BBC One HD" → "bbc-one-hd". */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'channel'
  );
}

export interface AliasKey {
  kind: Extract<AliasKind, 'name' | 'tvg_id'>;
  key: string;
}

/**
 * Keys that identify "the same channel" across providers, strongest first:
 * tvg-id (case-insensitive) then the normalised name ("UK: BBC One HD" → "bbc one").
 */
export function aliasKeys(stream: { name: string; tvgId: string | null }): AliasKey[] {
  const keys: AliasKey[] = [];
  const tvg = stream.tvgId?.trim().toLowerCase();
  if (tvg) keys.push({ kind: 'tvg_id', key: tvg });
  const name = normalizeChannelName(stream.name);
  if (name) keys.push({ kind: 'name', key: name });
  return keys;
}

/** Lineup numbering: positive, unique numbers; channels listed once. */
export function validateLineup(entries: readonly { channelId: string; number: number }[]): string | null {
  const numbers = new Set<number>();
  const channels = new Set<string>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.number) || entry.number <= 0 || entry.number > 99_999) return `Channel number ${entry.number} is not a positive whole number.`;
    if (numbers.has(entry.number)) return `Channel number ${entry.number} is used twice.`;
    if (channels.has(entry.channelId)) return 'A channel is listed twice.';
    numbers.add(entry.number);
    channels.add(entry.channelId);
  }
  return null;
}
