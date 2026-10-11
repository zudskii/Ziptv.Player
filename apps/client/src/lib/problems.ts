import type { ProblemKind, SourceProblem } from '@ziptv/contracts';

import { ApiError } from './api-client';

export interface ProblemCopy {
  title: string;
  description: string;
}

/**
 * Every failure the user can meet has its own wording and actions (spec: Error UX) —
 * never "Error 502".
 */
export const PROBLEMS: Record<ProblemKind, ProblemCopy> = {
  stream_unavailable: { title: 'Stream unavailable', description: "ZIPTV couldn't connect to this stream." },
  playlist_expired: {
    title: 'Playlist expired',
    description: 'Your provider no longer serves this playlist. Renew the subscription or update the playlist link.',
  },
  auth_failed: {
    title: 'Authentication failed',
    description: 'The provider rejected the credentials. Check the username and password (or the playlist link).',
  },
  source_unavailable: {
    title: 'Source unavailable',
    description: "Your provider isn't answering right now. ZIPTV keeps retrying in the background.",
  },
  epg_unavailable: {
    title: 'EPG unavailable',
    description: "The programme guide couldn't be loaded. Channels still play; schedules appear once the guide is reachable.",
  },
  unsupported_format: { title: 'Unsupported format', description: "This stream uses a format or codec this browser can't play." },
  parental_locked: { title: 'Locked', description: 'This content is protected by parental controls. Enter the PIN to watch it.' },
};

export const SOURCE_PROBLEMS: Record<SourceProblem, ProblemCopy & { kind: ProblemKind }> = {
  auth_failed: { kind: 'auth_failed', ...PROBLEMS.auth_failed },
  expired: { kind: 'playlist_expired', ...PROBLEMS.playlist_expired },
  unavailable: { kind: 'source_unavailable', ...PROBLEMS.source_unavailable },
  invalid: {
    kind: 'unsupported_format',
    title: 'Not a playlist',
    description: 'The link returned something that is not an M3U playlist (a web page, a login page or another file).',
  },
  empty: { kind: 'unsupported_format', title: 'No channels found', description: 'The playlist was read, but it contains no playable entries.' },
  too_large: { kind: 'unsupported_format', title: 'Playlist too large', description: 'The playlist is bigger than this server accepts.' },
  blocked: {
    kind: 'source_unavailable',
    title: 'Address not allowed',
    description: 'This link points to a private or local network address, which this server does not access.',
  },
  unknown: { kind: 'source_unavailable', ...PROBLEMS.source_unavailable },
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
