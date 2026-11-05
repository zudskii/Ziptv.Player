import type { Messages } from '@ziptv/i18n';
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
