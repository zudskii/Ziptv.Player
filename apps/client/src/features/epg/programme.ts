import type { ProgrammeDto } from '@ziptv/contracts';

export type ProgrammeState = 'past' | 'live' | 'upcoming';

export function programmeState(programme: Pick<ProgrammeDto, 'start' | 'end'>, now: number): ProgrammeState {
  if (new Date(programme.end).getTime() <= now) return 'past';
  if (new Date(programme.start).getTime() <= now) return 'live';
  return 'upcoming';
}

/** 0..1 of a programme on air (0 before, 1 after). */
export function programmeProgress(programme: Pick<ProgrammeDto, 'start' | 'end'>, now: number): number {
  const start = new Date(programme.start).getTime();
  const end = new Date(programme.end).getTime();
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function minutesLeft(programme: Pick<ProgrammeDto, 'end'>, now: number): number {
  return Math.max(0, Math.round((new Date(programme.end).getTime() - now) / 60_000));
}

/** Index of the programme on air (or the next one), to scroll a schedule into view. */
export function currentIndex(programmes: Pick<ProgrammeDto, 'start' | 'end'>[], now: number): number {
  const live = programmes.findIndex((programme) => programmeState(programme, now) === 'live');
  if (live >= 0) return live;
  const upcoming = programmes.findIndex((programme) => programmeState(programme, now) === 'upcoming');
  return upcoming >= 0 ? upcoming : programmes.length - 1;
}
