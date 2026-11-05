import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { ensureSession, hasLegacyGuest, useSessionStore } from './session';
import { gateDecision } from './session-policy';
import { t } from '../../i18n';

/**
 * Renders children only once a session exists. Where everyone else goes is decided in one place
 * (`gateDecision`), never by individual pages:
 * - first visit → `/welcome` (sign in, register or continue as a guest), then back here;
 * - signed out on purpose → `/login`, starting fresh;
 * - an account whose session ended → `/login` with its email, then back here (never silently a guest);
 * - a 1.x guest → its data is restored without asking.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const token = useSessionStore((state) => state.token);
  const account = useSessionStore((state) => state.account);
  const signedOut = useSessionStore((state) => state.signedOut);
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const decision = gateDecision({ token, account, signedOut }, hasLegacyGuest());
  const here = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (decision !== 'restore-guest') return;
    let cancelled = false;
    ensureSession().catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [decision, attempt]);

  switch (decision) {
    case 'render':
      return <>{children}</>;
    case 'sign-in-again':
      return <Navigate to="/login" replace state={{ from: here, expired: true, email: account?.email }} />;
    case 'sign-in':
      // The previous person's page is not a destination for whoever signs in next.
      return <Navigate to="/login" replace state={{ signedOut: true }} />;
    case 'welcome':
      return <Navigate to="/welcome" replace state={{ from: here }} />;
    case 'restore-guest':
      break;
  }
  if (error) {
    return (
      <FullscreenMessage
        tone="error"
        title={t('session.cantConnect')}
        description={error}
        action={{
          label: t('session.retry'),
          onClick: () => {
            setError(null);
            setAttempt((value) => value + 1);
          },
        }}
      />
    );
  }
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner label={t('session.preparing')} />
    </div>
  );
}
