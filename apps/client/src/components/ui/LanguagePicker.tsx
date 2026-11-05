import { LOCALE_NAMES, LOCALES, isLocale } from '@ziptv/i18n';
import { Languages } from 'lucide-react';

import { setLanguage, useT } from '../../i18n';
import { cn } from '../../lib/cn';

/**
 * The language of this device, for screens shown before any profile exists (welcome, sign-in).
 * Every language is named in itself, so a person can find theirs whatever is shown now.
 */
export function LanguagePicker({ className }: { className?: string }) {
  const { t, locale } = useT();
  return (
    <label className={cn('inline-flex items-center gap-1.5 text-sm text-fg-muted', className)}>
      <Languages className="h-4 w-4" aria-hidden />
      <span className="sr-only">{t('settings.language')}</span>
      <select
        className="rounded-md bg-transparent py-1 pr-1 text-sm text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) void setLanguage(event.target.value);
        }}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
