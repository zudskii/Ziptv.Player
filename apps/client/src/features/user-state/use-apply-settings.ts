import { useEffect, useRef } from 'react';

import { setClockFormat } from '../../lib/time';
import { readRawStorage } from '../../lib/storage';
import { setEngineOptions } from '../player/engines/types';
import { useProfileStore } from '../profiles/profile-store';
import { useThemeStore } from '../theme/theme-store';
import { useSettings, useUpdateSettings } from './api';
import { useDisplayPrefs } from './display-prefs';
import { i18n, setLanguage } from '../../i18n';

const THEME_SYNCED = 'ziptv:theme-synced';

/**
 * Applies the active profile's settings to the app: language, clock format, guide progress bars, decoder
 * workers and the theme. The theme chosen on this device before settings lived on the server
 * is carried over once instead of being reset to the default.
 */
export function useApplySettings(): void {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const profileId = useProfileStore((state) => state.profileId);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setClockFormat(settings.general.use24hClock);
    // The profile's language wins over the device's; '' leaves the device's as it is.
    const language = settings.general.language;
    if (language && language !== i18n.locale) void setLanguage(language);
    setEngineOptions({ worker: settings.playback.hardwareAcceleration });
    useDisplayPrefs.setState({ showProgress: settings.epg.showProgress, use24h: settings.general.use24hClock });

    const key = profileId ?? 'default';
    if (handled.current === key) return;
    handled.current = key;
    const local = useThemeStore.getState().preference;
    const remote = settings.appearance.theme;
    if (remote === local) return;
    const migrated = readRawStorage(THEME_SYNCED) === '1';
    if (!migrated && remote === 'system') {
      update.mutate({ appearance: { theme: local } });
    } else {
      useThemeStore.getState().setPreference(remote);
    }
    try {
      localStorage.setItem(THEME_SYNCED, '1');
    } catch {
      /* storage unavailable: carry-over may run again, harmless */
    }
  }, [settings, profileId, update]);
}
