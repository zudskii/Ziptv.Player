import type { SubscriptionDto } from '@ziptv/contracts';

import { i18n, t } from '../../i18n';

/** "9.99 GEL" — minor units, ISO currency; Intl when it knows the currency. */
export function formatPrice(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(i18n.locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(i18n.locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

type Tone = 'success' | 'brand' | 'warning' | 'danger' | 'neutral';
const status = (key: SubscriptionDto['status'], tone: Tone) => ({
  get label() {
    return t(`billing.status.${key}`);
  },
  tone,
});

export const STATUS_LABEL: Record<SubscriptionDto['status'], { readonly label: string; tone: Tone }> = {
  trialing: status('trialing', 'brand'),
  active: status('active', 'success'),
  past_due: status('past_due', 'warning'),
  grace: status('grace', 'danger'),
  canceled: status('canceled', 'neutral'),
  expired: status('expired', 'neutral'),
};
