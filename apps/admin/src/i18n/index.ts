import { createI18n, isLocale, negotiateLocale, type Locale, type MessageKey } from '@ziptv/i18n';
import { bindI18n } from '@ziptv/i18n/react';
import { createElement, Fragment, type ReactNode } from 'react';

import { en, type AppMessages } from './locales/en';

export type { Locale } from '@ziptv/i18n';
export type TKey = MessageKey<AppMessages>;

/** The console's language is a choice of this device (staff work from their own machines). */
const DEVICE_LOCALE_KEY = 'ziptv-console:locale';

function readStored(): string | null {
  try {
    return localStorage.getItem(DEVICE_LOCALE_KEY);
  } catch {
    return null;
  }
}

function deviceLocale(): Locale {
  const stored = readStored();
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

/** Hook: re-renders on a language change. */
export const useT = bindI18n(i18n);

export const t = (key: TKey, values?: Parameters<typeof i18n.t>[1]) => i18n.t(key, values);

/** A message with React parts (values or `<tag>` chunks). */
export function tx(key: TKey, values: Parameters<typeof i18n.rich<ReactNode>>[1]): ReactNode {
  return createElement(Fragment, null, ...i18n.rich<ReactNode>(key, values));
}

export async function setLanguage(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(DEVICE_LOCALE_KEY, locale);
  } catch {
    /* storage unavailable: lasts for this page load */
  }
  await i18n.setLocale(locale);
}

/** Loads the device's language before the first render. */
export function installI18n(): Promise<void> {
  const initial = deviceLocale();
  if (typeof document !== 'undefined') document.documentElement.lang = initial;
  return i18n.setLocale(initial).catch(() => undefined);
}

/** Dates and times in the console's language. */
export const formatDateTime = (value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) => new Date(value).toLocaleString(i18n.locale, options);

/** A status/state value from the API ("active", "past_due", "PROVIDER_OUTAGE"), translated when known. */
export function statusLabel(value: string): string {
  const key = `status.${value.toLowerCase()}` as TKey;
  const translated = i18n.t(key);
  return translated === key ? value.replace(/_/g, ' ').toLowerCase() : translated;
}
