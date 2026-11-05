/** Channel numbers the server accepts. */
import { t } from '../../i18n';
export const MAX_CHANNEL_NUMBER = 99_999;

/** Why a numbering scheme cannot be applied to `count` channels, or null when it can. */
export function numberingProblem(start: number, step: number, count: number): string | null {
  if (!Number.isInteger(start) || start < 1) return t('playlists.v.start');
  if (!Number.isInteger(step) || step < 1) return t('playlists.v.stepWhole');
  if (step > 1000) return t('playlists.v.stepMax');
  const last = start + Math.max(0, count - 1) * step;
  if (last > MAX_CHANNEL_NUMBER) return t('playlists.v.tooHigh', { last, max: MAX_CHANNEL_NUMBER });
  return null;
}
