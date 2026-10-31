/**
 * Watch-progress rules (Continue Watching, resume, history).
 *
 *  - Nothing is recorded for the first seconds (a click by mistake is not "watching").
 *  - An item is completed near its end (credits): it leaves Continue Watching.
 *  - Resume starts a few seconds before the saved position.
 */

export const PROGRESS_START_SECS = 30;
export const COMPLETED_RATIO = 0.92;
export const COMPLETED_REMAINING_SECS = 120;
export const RESUME_REWIND_SECS = 5;
/** A viewing shorter than this is not listed in History (zapping through channels). */
export const HISTORY_MIN_SECS = 10;
/** Credit at most this much watch time per heartbeat (a tab asleep for hours is not watching). */
export const MAX_HEARTBEAT_CREDIT_SECS = 60;

export type ProgressDecision = { action: 'skip' } | { action: 'save'; position: number; duration: number; completed: boolean };

export function decideProgress(position: number, duration: number, hasExisting: boolean): ProgressDecision {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0 || position < 0) return { action: 'skip' };
  const clamped = Math.min(position, duration);
  if (clamped < PROGRESS_START_SECS && !hasExisting) return { action: 'skip' };
  return { action: 'save', position: clamped, duration, completed: isCompleted(clamped, duration) };
}

export function isCompleted(position: number, duration: number): boolean {
  return duration > 0 && (position / duration >= COMPLETED_RATIO || duration - position <= Math.min(COMPLETED_REMAINING_SECS, duration * 0.25));
}

/** Where playback starts, or null for "from the beginning". */
export function resumeFrom(progress: { position: number; duration: number; completed: boolean } | null): number | null {
  if (!progress || progress.completed || progress.position < PROGRESS_START_SECS) return null;
  return Math.max(0, Math.floor(progress.position - RESUME_REWIND_SECS));
}

export function remainingSecs(position: number, duration: number): number {
  return Math.max(0, Math.round(duration - position));
}
