import { LOCALE_NAMES, LOCALES, isLocale } from '@ziptv/i18n';
import { Languages } from 'lucide-react';

import { setLanguage, useT } from '../i18n';

/** The console's language on this device; each language named in itself. */
export function LanguagePicker() {
  const { t, locale } = useT();
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <Languages className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{t('common.language')}</span>
      <select className="rounded bg-transparent py-0.5 text-xs text-fg-muted hover:text-fg" value={locale} onChange={(event) => isLocale(event.target.value) && void setLanguage(event.target.value)}>
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
