import type { MoneyDto } from '@ziptv/contracts';

import { i18n, t } from '../i18n';

/** "12.99 GEL" (Intl when it knows the currency). */
export function money(value: MoneyDto | null | undefined): string {
  if (!value) return '—';
  try {
    return new Intl.NumberFormat(i18n.locale, { style: 'currency', currency: value.currency }).format(value.amountMinor / 100);
  } catch {
    return `${(value.amountMinor / 100).toFixed(2)} ${value.currency}`;
  }
}

/** Several currencies: "12.99 GEL · 3.00 USD" ('—' when empty). */
export function moneyList(values: readonly MoneyDto[]): string {
  return values.length ? values.map(money).join(' · ') : '—';
}

export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(i18n.locale, { dateStyle: 'medium' }) : '—';
}

/** "5 min ago" / "in 3 h". */
export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' });
  for (const [ms, unit] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return rtf.format(Math.round(diff / 1000), 'second');
}

/** ISO date (yyyy-mm-dd) for <input type="date">. */
export function dateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/** <input type="date"> value → ISO midnight UTC (null when empty). */
export function fromDateInput(value: string): string | null {
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : null;
}

export function minutes(value: number): string {
  if (value < 60) return t('time.min', { n: Math.round(value) });
  const hours = value / 60;
  return t('time.h', { n: hours < 100 ? Math.round(hours * 10) / 10 : Math.round(hours) });
}
