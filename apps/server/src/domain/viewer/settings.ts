/**
 * Per-profile settings (Settings → General, Playback, Appearance, EPG, Data & Storage).
 * Stored as one partial JSON document; every read merges it over the defaults and drops values
 * that are no longer valid, so old or hand-edited documents can never break a client.
 * Parental rules (PIN, locks) are not part of this document.
 */

export type ThemeSetting = 'dark' | 'light' | 'system';
export type QualitySetting = 'auto' | 'highest' | 'lowest' | '1080' | '720' | '480';
export type StartPageSetting = 'home' | 'live' | 'guide' | 'movies' | 'series';

export interface ProfileSettings {
  general: { startPage: StartPageSetting; use24hClock: boolean };
  playback: {
    autoplay: boolean;
    autoplayNextEpisode: boolean;
    resumePlayback: boolean;
    preferredQuality: QualitySetting;
    preferredAudio: string;
    preferredSubtitles: string;
    hardwareAcceleration: boolean;
  };
  appearance: { theme: ThemeSetting };
  epg: { timeShiftMinutes: number; showProgress: boolean };
  data: { historyRetentionDays: number };
}

export type SettingsPatch = { [S in keyof ProfileSettings]?: Partial<ProfileSettings[S]> };
export type StoredProfileSettings = SettingsPatch;

export const DEFAULT_SETTINGS: ProfileSettings = {
  general: { startPage: 'home', use24hClock: true },
  playback: {
    autoplay: true,
    autoplayNextEpisode: true,
    resumePlayback: true,
    preferredQuality: 'auto',
    preferredAudio: '',
    preferredSubtitles: '',
    hardwareAcceleration: true,
  },
  appearance: { theme: 'system' },
  epg: { timeShiftMinutes: 0, showProgress: true },
  data: { historyRetentionDays: 180 },
};

export const MAX_TIME_SHIFT_MINUTES = 12 * 60;
export const HISTORY_RETENTION_CHOICES = [0, 30, 90, 180, 365] as const;

const THEMES: readonly ThemeSetting[] = ['dark', 'light', 'system'];
const QUALITIES: readonly QualitySetting[] = ['auto', 'highest', 'lowest', '1080', '720', '480'];
const START_PAGES: readonly StartPageSetting[] = ['home', 'live', 'guide', 'movies', 'series'];
const LANGUAGE = /^(?:|off|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/;

type Validators = { [S in keyof ProfileSettings]: { [K in keyof ProfileSettings[S]]: (value: unknown) => boolean } };

const isBool = (value: unknown) => typeof value === 'boolean';
const oneOf = (choices: readonly unknown[]) => (value: unknown) => choices.includes(value);

const VALIDATORS: Validators = {
  general: { startPage: oneOf(START_PAGES), use24hClock: isBool },
  playback: {
    autoplay: isBool,
    autoplayNextEpisode: isBool,
    resumePlayback: isBool,
    preferredQuality: oneOf(QUALITIES),
    preferredAudio: (value) => typeof value === 'string' && value !== 'off' && LANGUAGE.test(value),
    preferredSubtitles: (value) => typeof value === 'string' && LANGUAGE.test(value),
    hardwareAcceleration: isBool,
  },
  appearance: { theme: oneOf(THEMES) },
  epg: {
    timeShiftMinutes: (value) => Number.isInteger(value) && Math.abs(value as number) <= MAX_TIME_SHIFT_MINUTES,
    showProgress: isBool,
  },
  data: { historyRetentionDays: oneOf(HISTORY_RETENTION_CHOICES) },
};

/** Stored (partial, possibly stale) document → complete, valid settings. */
export function resolveSettings(stored: unknown): ProfileSettings {
  return mergeValid(DEFAULT_SETTINGS, stored);
}

/** Applies a patch; invalid fields are reported instead of silently dropped. */
export function applySettingsPatch(current: ProfileSettings, patch: SettingsPatch): { settings: ProfileSettings; invalid: string[] } {
  const invalid: string[] = [];
  for (const [section, fields] of Object.entries(patch)) {
    const validators = VALIDATORS[section as keyof ProfileSettings] as Record<string, (value: unknown) => boolean> | undefined;
    if (!validators || !fields || typeof fields !== 'object') {
      invalid.push(section);
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (!validators[field]?.(value)) invalid.push(`${section}.${field}`);
    }
  }
  return { settings: mergeValid(current, patch), invalid };
}

/** The stored form: only what differs from the defaults. */
export function toStoredSettings(settings: ProfileSettings): StoredProfileSettings {
  const stored: Record<string, Record<string, unknown>> = {};
  for (const section of Object.keys(DEFAULT_SETTINGS) as (keyof ProfileSettings)[]) {
    const defaults = DEFAULT_SETTINGS[section] as unknown as Record<string, unknown>;
    const values = settings[section] as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(values)) {
      if (value !== defaults[field]) (stored[section] ??= {})[field] = value;
    }
  }
  return stored as StoredProfileSettings;
}

function mergeValid(base: ProfileSettings, overlay: unknown): ProfileSettings {
  const result = structuredClone(base);
  if (!overlay || typeof overlay !== 'object') return result;
  for (const section of Object.keys(VALIDATORS) as (keyof ProfileSettings)[]) {
    const fields = (overlay as Record<string, unknown>)[section];
    if (!fields || typeof fields !== 'object') continue;
    const validators = VALIDATORS[section] as Record<string, (value: unknown) => boolean>;
    const target = result[section] as unknown as Record<string, unknown>;
    for (const [field, validate] of Object.entries(validators)) {
      const value = (fields as Record<string, unknown>)[field];
      if (value !== undefined && validate(value)) target[field] = value;
    }
  }
  return result;
}
