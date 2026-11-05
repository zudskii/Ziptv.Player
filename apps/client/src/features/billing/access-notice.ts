import { i18n, t, type TKey } from '../../i18n';

export interface AccessFailure {
  code?: string;
  apiDetails?: unknown;
  message: string;
}

/** The server's explanation in English; the code's translation in the other languages. */
function explanation(failure: AccessFailure): string {
  if (i18n.locale === 'en' || !failure.code) return failure.message;
  const key = `errors.code.${failure.code}` as TKey;
  const translated = t(key);
  return translated === key ? failure.message : translated;
}

/** Commerce reasons a stream was refused, with what the viewer can do about each. */
export function accessNotice(failure: AccessFailure): { title: string; description: string; kind: 'subscribe' | 'concurrency' | 'devices' | 'info' } | null {
  const reason = (failure.apiDetails as { reason?: unknown } | undefined)?.reason;
  switch (failure.code) {
    case 'NOT_ENTITLED':
      if (reason === 'no_subscription') return { kind: 'subscribe', title: t('access.subscriptionRequired.title'), description: t('access.subscriptionRequired.description') };
      if (reason === 'not_in_package') return { kind: 'subscribe', title: t('access.notInPackage.title'), description: t('access.notInPackage.description') };
      if (reason === 'account_blocked') return { kind: 'info', title: t('access.onHold'), description: explanation(failure) };
      if (reason === 'catchup_not_licensed') return { kind: 'info', title: t('access.catchup.title'), description: t('access.catchup.description') };
      return null;
    case 'UNPLAYABLE':
      if (reason === 'catchup_unavailable') return { kind: 'info', title: t('access.notInArchive'), description: explanation(failure) };
      return null;
    case 'CONCURRENCY_LIMIT':
      // The subscriber's own provider account (Multi-view, other devices): nothing to stop from here.
      if (reason === 'source_connections') return { kind: 'info', title: t('access.tooManyAccount'), description: explanation(failure) };
      return { kind: 'concurrency', title: t('access.tooMany'), description: explanation(failure) };
    case 'DEVICE_LIMIT':
      return { kind: 'devices', title: t('access.deviceLimit'), description: explanation(failure) };
    case 'NOT_FOUND':
      // A heartbeat for a viewing the server already ended (by a change of entitlement, or elsewhere).
      if (reason === 'no_subscription' || reason === 'not_in_package' || reason === 'account_blocked') return accessNotice({ ...failure, code: 'NOT_ENTITLED' });
      if (reason === 'stopped') return { kind: 'info', title: t('access.stopped.title'), description: t('access.stopped.remote') };
      if (reason === 'concurrency') return { kind: 'info', title: t('access.takenOver.title'), description: t('access.takenOver.description') };
      if (reason === 'device_revoked') return { kind: 'info', title: t('access.deviceRemoved.title'), description: t('access.deviceRemoved.description') };
      if (typeof reason === 'string') return { kind: 'info', title: t('access.stopped.title'), description: t('access.stopped.ended') };
      return null;
    default:
      return null;
  }
}
