import type { NotificationDto } from '@ziptv/contracts';
import { describe, expect, it } from 'vitest';

import { groupByDay } from './grouping';

const note = (id: string, createdAt: string): NotificationDto => ({ id, type: 'source_synced', severity: 'info', title: id, body: null, link: null, read: false, createdAt });

describe('notification groups', () => {
  it('splits newest-first items into Today / Yesterday / Earlier', () => {
    const now = new Date(2026, 9, 29, 15, 0);
    const groups = groupByDay([note('a', new Date(2026, 9, 29, 9).toISOString()), note('b', new Date(2026, 9, 28, 23).toISOString()), note('c', new Date(2026, 9, 20).toISOString())], now);
    expect(groups.map((group) => [group.day, group.label, group.items.map((item) => item.id)])).toEqual([
      ['today', 'Today', ['a']],
      ['yesterday', 'Yesterday', ['b']],
      ['earlier', 'Earlier', ['c']],
    ]);
    expect(groupByDay([], now)).toEqual([]);
  });
});
