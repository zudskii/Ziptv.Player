import type { ProblemKind, SourceProblem } from '@ziptv/contracts';

import { t } from '../i18n';
import { ApiError } from './api-client';

export interface ProblemCopy {
  title: string;
  description: string;
}

type CopyKey = ProblemKind | 'invalid' | 'empty' | 'too_large' | 'blocked';

/** Read when shown, so the wording follows the current language (getters: never spread them). */
const copy = (key: CopyKey): ProblemCopy => ({
  get title() {
    return t(`problems.${key}.title`);
  },
  get description() {
    return t(`problems.${key}.description`);
  },
});

/**
 * Every failure the user can meet has its own wording and actions (spec: Error UX) —
 * never "Error 502".
 */
export const PROBLEMS: Record<ProblemKind, ProblemCopy> = {
  stream_unavailable: copy('stream_unavailable'),
  playlist_expired: copy('playlist_expired'),
  auth_failed: copy('auth_failed'),
  source_unavailable: copy('source_unavailable'),
  epg_unavailable: copy('epg_unavailable'),
  unsupported_format: copy('unsupported_format'),
  parental_locked: copy('parental_locked'),
  not_entitled: copy('not_entitled'),
};

const withKind = (kind: ProblemKind, key: CopyKey): ProblemCopy & { kind: ProblemKind } => Object.defineProperties({ kind }, Object.getOwnPropertyDescriptors(copy(key))) as ProblemCopy & { kind: ProblemKind };

export const SOURCE_PROBLEMS: Record<SourceProblem, ProblemCopy & { kind: ProblemKind }> = {
  auth_failed: withKind('auth_failed', 'auth_failed'),
  expired: withKind('playlist_expired', 'playlist_expired'),
  unavailable: withKind('source_unavailable', 'source_unavailable'),
  invalid: withKind('unsupported_format', 'invalid'),
  empty: withKind('unsupported_format', 'empty'),
  too_large: withKind('unsupported_format', 'too_large'),
  blocked: withKind('source_unavailable', 'blocked'),
  unknown: withKind('source_unavailable', 'source_unavailable'),
};

/** Problem category of a failed API call (playback plan, catalog read). */
export function problemOf(error: unknown): ProblemKind {
  if (!(error instanceof ApiError)) return 'stream_unavailable';
  switch (error.code) {
    case 'PARENTAL_LOCKED':
    case 'PIN_REQUIRED':
      return 'parental_locked';
    case 'SOURCE_AUTH_FAILED':
      return 'auth_failed';
    case 'SOURCE_EXPIRED':
      return 'playlist_expired';
    case 'SOURCE_UNAVAILABLE':
      return 'source_unavailable';
    case 'NOT_ENTITLED':
      return 'not_entitled';
    case 'EPG_UNAVAILABLE':
      return 'epg_unavailable';
    case 'UNSUPPORTED_FORMAT':
      return 'unsupported_format';
    case 'UNPLAYABLE': {
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      return reason === 'unsupported_protocol' || reason === 'drm' || reason === 'unsupported_format' ? 'unsupported_format' : 'stream_unavailable';
    }
    default:
      return 'stream_unavailable';
  }
}
