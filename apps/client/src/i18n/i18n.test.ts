import { createI18n, negotiateLocale, type Messages } from '@ziptv/i18n';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';

import { en } from './locales/en';
import ka from './locales/ka';
import ru from './locales/ru';

/** Every leaf of a message tree as [dotted key, message]. */
function leaves(tree: Messages, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`)));
}

type Element = { type: number; value?: string; options?: Record<string, { value: Element[] }>; children?: Element[] };

/** The ICU arguments of a message: shown as values ({name}, {n, number}) and only branched on ({count, plural, …}). */
function argumentsOf(message: string, locale: string): { shown: Set<string>; all: Set<string> } {
  const shown = new Set<string>();
  const all = new Set<string>();
  const walk = (elements: Element[]) => {
    for (const element of elements) {
      // 1 argument · 2 number · 3 date · 4 time · 5 select · 6 plural · 8 tag
      if (element.type >= 1 && element.type <= 4 && element.value) shown.add(element.value);
      if ((element.type === 5 || element.type === 6) && element.value) all.add(element.value);
      if (element.type === 8 && element.value) all.add(element.value);
      for (const option of Object.values(element.options ?? {})) walk(option.value);
      if (element.children) walk(element.children);
    }
  };
  walk(new IntlMessageFormat(message, locale).getAst() as unknown as Element[]);
  for (const name of shown) all.add(name);
  return { shown, all };
}

describe('catalogs', () => {
  const source = leaves(en);
  const catalogs = { ka: leaves(ka as unknown as Messages), ru: leaves(ru as unknown as Messages) };

  it('have exactly the keys of English (the compiler checks this too)', () => {
    for (const [, messages] of Object.entries(catalogs)) expect(messages.map(([key]) => key)).toEqual(source.map(([key]) => key));
  });

  it('every message is valid ICU in its own language', () => {
    for (const [locale, messages] of Object.entries({ en: source, ...catalogs })) {
      for (const [key, message] of messages) {
        expect(() => new IntlMessageFormat(message, locale), `${locale}: ${key}`).not.toThrow();
      }
    }
  });

  it('translations show every value English shows, and use no others', () => {
    const english = new Map(source);
    for (const [locale, messages] of Object.entries(catalogs)) {
      for (const [key, message] of messages) {
        const source = argumentsOf(english.get(key)!, 'en');
        const translated = argumentsOf(message, locale);
        // A plural English needs may be unnecessary in Georgian ("3 წყარო"), but every value it prints must be printed.
        expect([...translated.all].filter((name) => !source.all.has(name)), `${locale}: ${key} uses unknown arguments`).toEqual([]);
        expect([...source.shown].filter((name) => !translated.all.has(name)), `${locale}: ${key} drops a value`).toEqual([]);
      }
    }
  });

  it('nothing is left untranslated by accident (Georgian has no Latin-only sentences)', () => {
    const latinOnly = catalogs.ka.filter(([, message]) => /[a-z]{4,}/i.test(message) && !/[ა-ჿ]/.test(message));
    // Brand names, formats and codes stay as they are; anything else would be a missed translation.
    const allowed = /^(?:[A-Z0-9 .:/·+()-]+|ZIPTV.*|M3U.*|EPG.*|Xtream.*|URL.*|PIN.*|TV.*|HD|4K|Wi-?Fi|PiP|English|Русский|ქართული|[{}#\w, ]*\{.*)$/;
    expect(latinOnly.filter(([, message]) => !allowed.test(message)).map(([key]) => key)).toEqual([]);
  });
});

describe('runtime', () => {
  const messages = {
    sources: '{count, plural, one {# source} other {# sources}}',
    hello: 'Hello, {name}',
  } as const satisfies Messages;
  const translations = {
    ka: { sources: '{count, plural, one {# წყარო} other {# წყარო}}', hello: 'გამარჯობა, {name}' },
    ru: { sources: '{count, plural, one {# источник} few {# источника} many {# источников} other {# источника}}', hello: 'Привет, {name}' },
  };
  const make = () => createI18n<typeof messages>({ source: messages, load: { ka: async () => ({ default: translations.ka }), ru: async () => ({ default: translations.ru }) } });

  it('formats Russian plurals with all their forms (1, 2–4, 5+, 21, 22, 25)', async () => {
    const i18n = make();
    await i18n.setLocale('ru');
    expect([1, 2, 5, 21, 22, 25, 11].map((count) => i18n.t('sources', { count }))).toEqual(['1 источник', '2 источника', '5 источников', '21 источник', '22 источника', '25 источников', '11 источников']);
  });

  it('formats Georgian and English plurals', async () => {
    const i18n = make();
    expect(i18n.t('sources', { count: 1 })).toBe('1 source');
    expect(i18n.t('sources', { count: 3 })).toBe('3 sources');
    await i18n.setLocale('ka');
    expect(i18n.t('sources', { count: 3 })).toBe('3 წყარო');
    expect(i18n.t('hello', { name: 'ზურა' })).toBe('გამარჯობა, ზურა');
  });

  it('never throws on a missing value or key: it shows the key', () => {
    const i18n = make();
    expect(i18n.t('hello')).toBe('hello');
    expect(i18n.t('nope' as never)).toBe('nope');
  });

  it('a slower earlier switch never overrides a later one', async () => {
    let releaseKa!: () => void;
    const i18n = createI18n<typeof messages>({
      source: messages,
      load: {
        ka: () => new Promise((resolve) => (releaseKa = () => resolve({ default: translations.ka }))),
        ru: async () => ({ default: translations.ru }),
      },
    });
    const slow = i18n.setLocale('ka');
    await i18n.setLocale('ru');
    releaseKa();
    await slow;
    expect(i18n.locale).toBe('ru');
  });

  it('notifies subscribers once per change', async () => {
    const i18n = make();
    let calls = 0;
    i18n.subscribe(() => (calls += 1));
    await i18n.setLocale('ka');
    await i18n.setLocale('ka');
    expect(calls).toBe(1);
  });

  it('picks the device language from the browser preferences', () => {
    expect(negotiateLocale(['ru-RU', 'en'])).toBe('ru');
    expect(negotiateLocale(['de-DE', 'ka'])).toBe('ka');
    expect(negotiateLocale(['de-DE'])).toBe('en');
    expect(negotiateLocale(undefined, 'ka')).toBe('ka');
  });
});
