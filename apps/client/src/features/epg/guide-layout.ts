/** Geometry of the TV Guide grid (time → pixels). Pure, so it is unit-tested. */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export interface DayWindow {
  /** Local midnight of the day shown. */
  start: number;
  /** Next local midnight (+ a small overflow so late programmes are not cut). */
  end: number;
}

/** Local day containing `time`, shifted by `offsetDays`. */
export function dayWindow(time: number, offsetDays = 0, overflowHours = 2): DayWindow {
  const date = new Date(time);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays + 1).getTime() + overflowHours * HOUR_MS;
  return { start, end };
}

/** Left/width of a programme block, clipped to the window; null when outside it. */
export function blockGeometry(programme: { start: string; end: string }, window: DayWindow, pxPerMinute: number): { left: number; width: number } | null {
  const start = Math.max(new Date(programme.start).getTime(), window.start);
  const end = Math.min(new Date(programme.end).getTime(), window.end);
  if (end <= start) return null;
  return { left: ((start - window.start) / MINUTE_MS) * pxPerMinute, width: ((end - start) / MINUTE_MS) * pxPerMinute };
}

/** Ruler ticks every `stepMinutes` across the window. */
export function timeSlots(window: DayWindow, stepMinutes = 30): number[] {
  const slots: number[] = [];
  for (let time = window.start; time < window.end; time += stepMinutes * MINUTE_MS) slots.push(time);
  return slots;
}

export function offsetFor(time: number, window: DayWindow, pxPerMinute: number): number {
  return ((time - window.start) / MINUTE_MS) * pxPerMinute;
}

export function windowWidth(window: DayWindow, pxPerMinute: number): number {
  return ((window.end - window.start) / MINUTE_MS) * pxPerMinute;
}

/** Row pages needed for the visible rows (each page = `pageSize` channels from the API). */
export function pagesFor(firstRow: number, lastRow: number, pageSize: number): number[] {
  if (lastRow < firstRow) return [];
  const pages: number[] = [];
  for (let page = Math.floor(firstRow / pageSize); page <= Math.floor(lastRow / pageSize); page++) pages.push(page);
  return pages;
}
