import type { NotificationDto } from '@ziptv/contracts';

/** Today / Yesterday / Earlier, newest first (the list arrives newest first). */
export function groupByDay(items: readonly NotificationDto[], now = new Date()): { label: string; items: NotificationDto[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const groups = new Map<string, NotificationDto[]>();
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    const label = at >= startOfToday ? 'Today' : at >= startOfYesterday ? 'Yesterday' : 'Earlier';
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return ['Today', 'Yesterday', 'Earlier'].filter((label) => groups.has(label)).map((label) => ({ label, items: groups.get(label)! }));
}
