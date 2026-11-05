import type { NotificationDto } from '@ziptv/contracts';

import { t } from '../../i18n';

export type NotificationDay = 'today' | 'yesterday' | 'earlier';
const DAYS: readonly NotificationDay[] = ['today', 'yesterday', 'earlier'];

/** Today / Yesterday / Earlier, newest first (the list arrives newest first). */
export function groupByDay(items: readonly NotificationDto[], now = new Date()): { day: NotificationDay; label: string; items: NotificationDto[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const groups = new Map<NotificationDay, NotificationDto[]>();
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    const day: NotificationDay = at >= startOfToday ? 'today' : at >= startOfYesterday ? 'yesterday' : 'earlier';
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return DAYS.filter((day) => groups.has(day)).map((day) => ({ day, label: t(`notifications.day.${day}`), items: groups.get(day)! }));
}
