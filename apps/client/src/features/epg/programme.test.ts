import { describe, expect, it } from 'vitest';

import { currentIndex, minutesLeft, programmeProgress, programmeState } from './programme';

const p = (start: string, end: string) => ({ start: `2026-10-01T${start}:00Z`, end: `2026-10-01T${end}:00Z` });
const at = (time: string) => new Date(`2026-10-01T${time}:00Z`).getTime();

describe('programme helpers', () => {
  it('state, progress and minutes left', () => {
    const programme = p('14:00', '16:00');
    expect(programmeState(programme, at('13:00'))).toBe('upcoming');
    expect(programmeState(programme, at('15:00'))).toBe('live');
    expect(programmeState(programme, at('16:00'))).toBe('past');
    expect(programmeProgress(programme, at('15:26'))).toBeCloseTo(0.7167, 3);
    expect(minutesLeft(programme, at('15:26'))).toBe(34);
  });

  it('finds the programme to scroll to', () => {
    const list = [p('10:00', '11:00'), p('11:00', '12:00'), p('13:00', '14:00')];
    expect(currentIndex(list, at('11:30'))).toBe(1);
    expect(currentIndex(list, at('12:30'))).toBe(2); // gap → next
    expect(currentIndex(list, at('15:00'))).toBe(2);
  });
});
