import { createI18n, isLocale, negotiateLocale, type Locale, type MessageKey } from '@ziptv/i18n';
import { bindI18n } from '@ziptv/i18n/react';
import { createElement, Fragment, type ReactNode } from 'react';

import { readRawStorage } from '../lib/storage';
import { en, type AppMessages } from './locales/en';

export type { Locale } from '@ziptv/i18n';
export type TKey = MessageKey<AppMessages>;

/** This device's last language: used before any profile settings are known (welcome, sign-in). */
const DEVICE_LOCALE_KEY = 'ziptv:locale';

function deviceLocale(): Locale {
  const stored = readRawStorage(DEVICE_LOCALE_KEY);
  if (isLocale(stored)) return stored;
  return negotiateLocale(typeof navigator === 'undefined' ? [] : navigator.languages);
}

export const i18n = createI18n<AppMessages>({
  source: en,
  load: { ka: () => import('./locales/ka'), ru: () => import('./locales/ru') },
  onChange: (locale) => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  },
});

/** Hook: `const { t, locale } = useT();` — re-renders on a language change. */
export const useT = bindI18n(i18n);

/** For code outside components (toasts, error messages, document title). */
export const t = (key: TKey, values?: Parameters<typeof i18n.t>[1]) => i18n.t(key, values);

/**
 * A message with React parts: `tx('auth.sentTo', { email: <strong>{email}</strong> })`, or tags
 * in the message itself: `'Read <link>the guide</link>'` with `{ link: (chunks) => <a>{chunks}</a> }`.
 */
export function tx(key: TKey, values: Parameters<typeof i18n.rich<ReactNode>>[1]): ReactNode {
  return createElement(Fragment, null, ...i18n.rich<ReactNode>(key, values));
}

/**
 * Shows the app in `locale` and remembers it on this device. The profile's own choice (Settings →
 * General → Language) is applied over it once settings load; `''` there means "this device's".
 */
export async function setLanguage(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(DEVICE_LOCALE_KEY, locale);
  } catch {
    /* storage unavailable: the choice lasts for this page load */
  }
  await i18n.setLocale(locale);
}

/** The language this device would use without a profile preference. */
export const deviceLanguage = deviceLocale;

/** Loads the device's language before the first render (no flash of English for ka/ru). */
export function installI18n(): Promise<void> {
  const initial = deviceLocale();
  if (typeof document !== 'undefined') document.documentElement.lang = initial;
  return i18n.setLocale(initial).catch(() => undefined);
}
