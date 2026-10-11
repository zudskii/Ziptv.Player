import type { ThemePreference } from '@ziptv/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistentStorage } from '../../lib/storage';

interface ThemeState {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

/** Appearance: Dark / Light / System. Persisted per device and synced with server settings. */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: 'dark',
      setPreference: (preference) => {
        set({ preference });
        applyTheme(preference);
      },
    }),
    { name: 'ziptv:theme', storage: persistentStorage, version: 1 },
  ),
);

const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function resolveTheme(preference: ThemePreference): 'dark' | 'light' {
  if (preference !== 'system') return preference;
  return typeof window !== 'undefined' && window.matchMedia?.(LIGHT_QUERY).matches ? 'light' : 'dark';
}

export function applyTheme(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme(preference);
  const root = document.documentElement;
  root.classList.toggle('theme-light', theme === 'light');
  root.classList.toggle('theme-dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#0b1120');
}

/** Keeps the document in sync with the stored preference and the OS setting (for "System"). */
export function installThemeSync(): () => void {
  applyTheme(useThemeStore.getState().preference);
  const media = window.matchMedia?.(LIGHT_QUERY);
  const onChange = () => {
    if (useThemeStore.getState().preference === 'system') applyTheme('system');
  };
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}
