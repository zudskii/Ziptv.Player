export interface AccessFailure {
  code?: string;
  apiDetails?: unknown;
  message: string;
}

/** Commerce reasons a stream was refused, with what the viewer can do about each. */
export function accessNotice(failure: AccessFailure): { title: string; description: string; kind: 'subscribe' | 'concurrency' | 'devices' | 'info' } | null {
  const reason = (failure.apiDetails as { reason?: unknown } | undefined)?.reason;
  switch (failure.code) {
    case 'NOT_ENTITLED':
      if (reason === 'no_subscription') return { kind: 'subscribe', title: 'Subscription required', description: 'This channel is part of a ZIPTV package. Subscribe to start watching.' };
      if (reason === 'not_in_package') return { kind: 'subscribe', title: 'Not in your package', description: 'Your current package does not include this channel. See which plans have it.' };
      if (reason === 'account_blocked') return { kind: 'info', title: 'Account on hold', description: failure.message };
      return null;
    case 'CONCURRENCY_LIMIT':
      return { kind: 'concurrency', title: 'Too many streams', description: failure.message };
    case 'DEVICE_LIMIT':
      return { kind: 'devices', title: 'Device limit reached', description: failure.message };
    case 'NOT_FOUND':
      // A heartbeat for a viewing the server already ended (by a change of entitlement, or elsewhere).
      if (reason === 'no_subscription' || reason === 'not_in_package' || reason === 'account_blocked') return accessNotice({ ...failure, code: 'NOT_ENTITLED' });
      if (reason === 'stopped') return { kind: 'info', title: 'Playback stopped', description: 'It was stopped from another device. Press Retry to watch here again.' };
      if (reason === 'concurrency') return { kind: 'info', title: 'Another device took over', description: 'Your plan’s streams are in use elsewhere. Press Retry to watch here.' };
      if (reason === 'device_revoked') return { kind: 'info', title: 'This device was removed', description: 'It was removed from your account. Press Retry to add it again.' };
      if (typeof reason === 'string') return { kind: 'info', title: 'Playback stopped', description: 'This viewing has ended. Press Retry to watch again.' };
      return null;
    default:
      return null;
  }
}
