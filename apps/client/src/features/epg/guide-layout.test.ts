import { describe, expect, it } from 'vitest';

import { blockGeometry, dayWindow, HOUR_MS, offsetFor, pagesFor, timeSlots, windowWidth } from './guide-layout';

describe('guide layout', () => {
  const window = { start: Date.parse('2026-10-01T00:00:00Z'), end: Date.parse('2026-10-02T02:00:00Z') };

  it('positions programmes in pixels and clips them to the window', () => {
    expect(blockGeometry({ start: '2026-10-01T14:00:00Z', end: '2026-10-01T16:00:00Z' }, window, 4)).toEqual({ left: 14 * 240, width: 480 });
    expect(blockGeometry({ start: '2026-09-30T23:00:00Z', end: '2026-10-01T01:00:00Z' }, window, 4)).toEqual({ left: 0, width: 240 });
    expect(blockGeometry({ start: '2026-10-02T03:00:00Z', end: '2026-10-02T04:00:00Z' }, window, 4)).toBeNull();
  });

  it('builds ruler slots, offsets and widths', () => {
    const slots = timeSlots(window, 30);
    expect(slots).toHaveLength(52);
    expect(slots[1]! - slots[0]!).toBe(HOUR_MS / 2);
    expect(offsetFor(window.start + HOUR_MS, window, 3)).toBe(180);
    expect(windowWidth(window, 2)).toBe(26 * 120);
  });

  it('computes local day windows and row pages', () => {
    const day = dayWindow(Date.parse('2026-10-01T15:30:00'), 1);
    expect(new Date(day.start).getHours()).toBe(0);
    expect(new Date(day.start).getDate()).toBe(2);
    expect(day.end - day.start).toBe(26 * HOUR_MS);
    expect(pagesFor(35, 85, 40)).toEqual([0, 1, 2]);
    expect(pagesFor(5, 4, 40)).toEqual([]);
  });
});
