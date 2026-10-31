import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { ensureSession, useSessionStore } from './session';
import { needsSignIn } from './session-policy';

/**
 * Renders children only once a session exists: a guest is created on first visit; an account whose
 * session ended is sent to the sign-in page (never silently replaced by an empty guest).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const token = useSessionStore((state) => state.token);
  const account = useSessionStore((state) => state.account);
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const signInRequired = needsSignIn({ token, account });

  useEffect(() => {
    if (token || signInRequired) return;
    let cancelled = false;
    ensureSession().catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [token, signInRequired, attempt]);

  if (token) return <>{children}</>;
  if (signInRequired) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}`, expired: true, email: account?.email }} />;
  if (error) {
    return (
      <FullscreenMessage
        tone="error"
        title="Can't connect to ZIPTV"
        description={error}
        action={{
          label: 'Try again',
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
      <Spinner label="Preparing your player…" />
    </div>
  );
}
