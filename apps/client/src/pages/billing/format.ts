import type { SubscriptionDto } from '@ziptv/contracts';

/** "9.99 GEL" — minor units, ISO currency; Intl when it knows the currency. */
export function formatPrice(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export const STATUS_LABEL: Record<SubscriptionDto['status'], { label: string; tone: 'success' | 'brand' | 'warning' | 'danger' | 'neutral' }> = {
  trialing: { label: 'Free trial', tone: 'brand' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Payment failed', tone: 'warning' },
  grace: { label: 'Payment overdue', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  expired: { label: 'Ended', tone: 'neutral' },
};
