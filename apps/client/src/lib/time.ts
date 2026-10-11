/** Time/duration formatting shared by the guide, history and player. */

let use24h = true;

export function setClockFormat(twentyFourHours: boolean): void {
  use24h = twentyFourHours;
}

export function formatClock(value: Date | string | number): string {
  const date = new Date(value);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: !use24h });
}

export function formatRange(start: string | Date, end: string | Date): string {
  return `${formatClock(start)} – ${formatClock(end)}`;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", "Tomorrow", else "Sep 28" / "Mon, Sep 28". */
export function formatDay(value: Date | string | number, now = Date.now()): string {
  const date = new Date(value);
  const diff = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, Math.abs(diff) < 7 ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

/** "Today 09:42", "Yesterday", "Sep 28" — Watch history style. */
export function formatWhen(value: Date | string | number, now = Date.now()): string {
  const day = formatDay(value, now);
  return day === 'Today' ? `Today ${formatClock(value)}` : day;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function formatAgo(value: Date | string | number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "in 5 h", "in 12 min". */
export function formatIn(value: Date | string | number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '—';
  const minutes = Math.round((new Date(value).getTime() - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

/** 5400 → "1 h 30 min", 1380 → "23 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** 3725 → "1:02:05", 65 → "1:05". */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
