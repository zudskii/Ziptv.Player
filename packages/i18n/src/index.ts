import { IntlMessageFormat, type FormatXMLElementFn, type PrimitiveType } from 'intl-messageformat';

/**
 * ZIPTV's languages. English is the source language: its catalog is bundled and complete by
 * definition; Georgian and Russian are loaded on demand and must have exactly the same keys
 * (enforced by the `Catalog<M>` type — a missing or extra key is a compile error, not a runtime
 * surprise).
 */
export const LOCALES = ['ka', 'en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const SOURCE_LOCALE: Locale = 'en';

/** Each language named in itself: what a person looks for in a language picker. */
export const LOCALE_NAMES: Record<Locale, string> = { ka: 'ქართული', en: 'English', ru: 'Русский' };

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/** A message tree: nested namespaces, ICU MessageFormat strings at the leaves. */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** The same tree shape with any strings: what a translation must provide. */
export type Catalog<M> = { readonly [K in keyof M]: M[K] extends string ? string : Catalog<M[K]> };

/** Every leaf as a dotted path: `'auth.signIn'`. */
export type MessageKey<M> = {
  [K in keyof M & string]: M[K] extends string ? K : `${K}.${MessageKey<M[K]>}`;
}[keyof M & string];

export type MessageValues = Record<string, PrimitiveType | Date>;

/**
 * The language a device starts in, from the browser's preferences (`navigator.languages`):
 * the first one we have, by primary subtag (`ru-RU` → `ru`), else the fallback.
 */
export function negotiateLocale(preferred: readonly string[] | undefined, fallback: Locale = SOURCE_LOCALE): Locale {
  for (const tag of preferred ?? []) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return fallback;
}

export interface I18nOptions<M extends Messages> {
  /** The English catalog (bundled). */
  source: M;
  /** Loaders for the other languages, e.g. `() => import('./locales/ka')`. */
  load: { [L in Exclude<Locale, 'en'>]: () => Promise<{ default: Catalog<M> }> };
  initial?: Locale;
  /** Called after every change of language (e.g. to set `<html lang>`). */
  onChange?: (locale: Locale) => void;
}

export interface I18n<M extends Messages> {
  /** The language currently shown (its catalog is loaded). */
  readonly locale: Locale;
  /** Formats one message of the current language. Never throws: a broken message shows its key. */
  t(key: MessageKey<M>, values?: MessageValues): string;
  /**
   * Formats a message whose values (or `<tag>…</tag>` chunks) are rich objects, e.g. React
   * elements: `rich('auth.sentTo', { email: <strong>{email}</strong> })`. Returns the parts.
   */
  rich<T>(key: MessageKey<M>, values: Record<string, PrimitiveType | Date | T | FormatXMLElementFn<T, unknown>>): (string | T)[];
  /** Loads the language if needed, then switches every subscriber to it. */
  setLocale(locale: Locale): Promise<void>;
  subscribe(listener: () => void): () => void;
  /** Dates, numbers and lists in the current language. */
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatList(items: readonly string[], options?: Intl.ListFormatOptions): string;
  formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string;
}

/** Looks a dotted path up in a message tree. */
export function lookup(tree: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function createI18n<M extends Messages>(options: I18nOptions<M>): I18n<M> {
  const catalogs = new Map<Locale, Messages>([[SOURCE_LOCALE, options.source]]);
  const formats = new Map<string, IntlMessageFormat>();
  const listeners = new Set<() => void>();
  let current: Locale = SOURCE_LOCALE;
  let requested: Locale = SOURCE_LOCALE;

  const formatter = (locale: Locale, key: string): IntlMessageFormat | null => {
    const id = `${locale}\u0000${key}`;
    const cached = formats.get(id);
    if (cached) return cached;
    // A key missing from a translation (only possible with a hand-edited bundle) falls back to English.
    const message = lookup(catalogs.get(locale) ?? options.source, key) ?? lookup(options.source, key);
    if (message === undefined) return null;
    try {
      const format = new IntlMessageFormat(message, locale);
      formats.set(id, format);
      return format;
    } catch {
      return null;
    }
  };

  const i18n: I18n<M> = {
    get locale() {
      return current;
    },
    t(key, values) {
      const format = formatter(current, key);
      if (!format) return key;
      try {
        return String(format.format(values));
      } catch {
        return key; // a value the message needs is missing
      }
    },
    rich<T>(key: MessageKey<M>, values: Record<string, PrimitiveType | Date | T | FormatXMLElementFn<T, unknown>>) {
      const format = formatter(current, key);
      if (!format) return [key];
      try {
        const result = format.format<T>(values as never);
        return (Array.isArray(result) ? result : [result]).flat() as (string | T)[];
      } catch {
        return [key];
      }
    },
    async setLocale(locale) {
      requested = locale;
      if (!catalogs.has(locale) && locale !== 'en') {
        const module = await options.load[locale]();
        catalogs.set(locale, module.default as Messages);
      }
      // A slower earlier request must not win over a later one.
      if (requested !== locale || current === locale) return;
      current = locale;
      options.onChange?.(locale);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    formatDate: (value, opts) => new Intl.DateTimeFormat(current, opts).format(value),
    formatNumber: (value, opts) => new Intl.NumberFormat(current, opts).format(value),
    formatList: (items, opts) => new Intl.ListFormat(current, { type: 'conjunction', ...opts }).format(items),
    formatRelative: (value, unit) => new Intl.RelativeTimeFormat(current, { numeric: 'auto' }).format(value, unit),
  };
  if (options.initial && options.initial !== SOURCE_LOCALE) void i18n.setLocale(options.initial);
  return i18n;
}
