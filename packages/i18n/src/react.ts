import { useCallback, useSyncExternalStore } from 'react';

import type { I18n, Locale, MessageKey, Messages, MessageValues } from './index';

/**
 * React binding: components using the returned hook re-render when the language changes.
 *
 *   export const useT = bindI18n(i18n);
 *   const { t, locale } = useT();
 */
export function bindI18n<M extends Messages>(i18n: I18n<M>) {
  const getLocale = () => i18n.locale;
  return function useI18n(): { t: (key: MessageKey<M>, values?: MessageValues) => string; locale: Locale; i18n: I18n<M> } {
    const locale = useSyncExternalStore(i18n.subscribe, getLocale, getLocale);
    // A new `t` per language (`locale` is the dependency on purpose), so memoised children that receive it re-render too.
    const t = useCallback((key: MessageKey<M>, values?: MessageValues) => i18n.t(key, values), [locale]);
    return { t, locale, i18n };
  };
}
