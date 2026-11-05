import { describe, expect, it } from 'vitest';

import { nextProfileColor, normalizeProfileName } from './profile.js';
import { decideProgress, isCompleted, resumeFrom } from './progress.js';
import { applySettingsPatch, DEFAULT_SETTINGS, resolveSettings, toStoredSettings } from './settings.js';

describe('settings', () => {
  it('merges stored values over defaults and drops invalid or unknown ones', () => {
    const settings = resolveSettings({ appearance: { theme: 'light' }, epg: { timeShiftMinutes: 99999, showProgress: false }, bogus: { x: 1 }, playback: 'x' });
    expect(settings.appearance.theme).toBe('light');
    expect(settings.epg).toEqual({ timeShiftMinutes: 0, showProgress: false });
    expect(settings.playback).toEqual(DEFAULT_SETTINGS.playback);
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('reports invalid patch fields and stores only differences from the defaults', () => {
    const { settings, invalid } = applySettingsPatch(DEFAULT_SETTINGS, {
      general: { startPage: 'movies' },
      playback: { preferredSubtitles: 'off', preferredAudio: 'ka', preferredQuality: '4k' as never },
      data: { historyRetentionDays: 7 },
    });
    expect(invalid).toEqual(['playback.preferredQuality', 'data.historyRetentionDays']);
    expect(settings.general.startPage).toBe('movies');
    expect(toStoredSettings(settings)).toEqual({ general: { startPage: 'movies' }, playback: { preferredSubtitles: 'off', preferredAudio: 'ka' } });
  });

  it('keeps a language per profile: one of the app languages, or "" for the device’s', () => {
    expect(DEFAULT_SETTINGS.general.language).toBe('');
    for (const language of ['ka', 'en', 'ru', ''] as const) {
      const { settings, invalid } = applySettingsPatch(DEFAULT_SETTINGS, { general: { language } });
      expect(invalid).toEqual([]);
      expect(settings.general.language).toBe(language);
    }
    expect(applySettingsPatch(DEFAULT_SETTINGS, { general: { language: 'de' as never } }).invalid).toEqual(['general.language']);
    expect(resolveSettings({ general: { language: 'xx' } }).general.language).toBe('');
    expect(toStoredSettings(applySettingsPatch(DEFAULT_SETTINGS, { general: { language: 'ka' } }).settings)).toEqual({ general: { language: 'ka' } });
  });
});

describe('help settings', () => {
  it('remember which tips a profile has seen, as a short list of known-shaped ids', () => {
    expect(DEFAULT_SETTINGS.help).toEqual({ seen: [], checklistDismissed: false });
    const { settings, invalid } = applySettingsPatch(DEFAULT_SETTINGS, { help: { seen: ['tour-guide', 'visited-settings'], checklistDismissed: true } });
    expect(invalid).toEqual([]);
    expect(toStoredSettings(settings)).toEqual({ help: { seen: ['tour-guide', 'visited-settings'], checklistDismissed: true } });
    for (const seen of [['Bad Id'], ['a', 'a'], Array.from({ length: 51 }, (_, i) => `t${i}`), 'tour-guide']) {
      expect(applySettingsPatch(DEFAULT_SETTINGS, { help: { seen: seen as never } }).invalid, JSON.stringify(seen).slice(0, 40)).toEqual(['help.seen']);
    }
  });

  it('an emptied list is the default again and is not stored ("show tips again")', () => {
    const shown = applySettingsPatch(DEFAULT_SETTINGS, { help: { seen: ['tour-guide'] } }).settings;
    expect(toStoredSettings(applySettingsPatch(shown, { help: { seen: [], checklistDismissed: false } }).settings)).toEqual({});
    expect(resolveSettings({ help: { seen: ['ok', 7] } }).help.seen).toEqual([]);
  });
});

describe('progress rules', () => {
  it('skips the first seconds unless progress already exists', () => {
    expect(decideProgress(10, 3600, false)).toEqual({ action: 'skip' });
    expect(decideProgress(10, 3600, true)).toEqual({ action: 'save', position: 10, duration: 3600, completed: false });
    expect(decideProgress(Number.NaN, 3600, true)).toEqual({ action: 'skip' });
    expect(decideProgress(5000, 3600, true)).toMatchObject({ position: 3600, completed: true });
  });

  it('completes near the end (ratio or credits) and resumes slightly earlier', () => {
    expect(isCompleted(3490, 3600)).toBe(true); // under 2 min left
    expect(isCompleted(3300, 3600)).toBe(false);
    expect(isCompleted(1000, 3600)).toBe(false);
    expect(isCompleted(250, 300)).toBe(true); // short clip: a quarter of it at most counts as credits
    expect(resumeFrom({ position: 600, duration: 3600, completed: false })).toBe(595);
    expect(resumeFrom({ position: 20, duration: 3600, completed: false })).toBeNull();
    expect(resumeFrom({ position: 3500, duration: 3600, completed: true })).toBeNull();
  });
});

describe('profiles', () => {
  it('picks an unused colour and normalises names', () => {
    expect(nextProfileColor(['#3B82F6'])).toBe('#22c55e');
    expect(normalizeProfileName('  Kids   room \n')).toBe('Kids room');
  });
});
