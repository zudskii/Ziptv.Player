/** Channel numbers the server accepts. */
export const MAX_CHANNEL_NUMBER = 99_999;

/** Why a numbering scheme cannot be applied to `count` channels, or null when it can. */
export function numberingProblem(start: number, step: number, count: number): string | null {
  if (!Number.isInteger(start) || start < 1) return 'Start at a whole number of 1 or more.';
  if (!Number.isInteger(step) || step < 1) return 'The step must be a whole number of 1 or more.';
  if (step > 1000) return 'The step can be at most 1000.';
  const last = start + Math.max(0, count - 1) * step;
  if (last > MAX_CHANNEL_NUMBER) return `That would reach ${last.toLocaleString('en-US')}; the highest channel number is ${MAX_CHANNEL_NUMBER.toLocaleString('en-US')}.`;
  return null;
}
