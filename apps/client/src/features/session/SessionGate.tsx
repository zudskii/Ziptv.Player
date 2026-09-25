import { useEffect, useState, type ReactNode } from 'react';

import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { ensureSession, useSessionStore } from './session';

/** Renders children only once an anonymous session exists (created on first visit). */
export function SessionGate({ children }: { children: ReactNode }) {
  const token = useSessionStore((state) => state.token);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    ensureSession().catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  if (token) return <>{children}</>;
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
