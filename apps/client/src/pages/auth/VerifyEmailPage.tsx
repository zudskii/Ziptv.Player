import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { Spinner } from '../../components/ui/Spinner';
import { authApi, authKeys } from '../../features/auth/api';
import { tokenFromFragment } from '../../features/auth/email-links';
import { errorMessage } from '../../lib/api-client';
import { AuthShell, FormError } from './AuthShell';

type State = { status: 'working' } | { status: 'done' } | { status: 'failed'; message: string };

/** Opened from the confirmation email, often on a device that is not signed in: it needs no session. */
export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(() => tokenFromFragment(location.hash));
  const [state, setState] = useState<State>(token ? { status: 'working' } : { status: 'failed', message: 'The address is incomplete or damaged. Open the link from the email again.' });
  // The link works once; development builds run effects twice and the second try would read "already used".
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    navigate({ hash: '' }, { replace: true });
    authApi
      .verifyEmail({ token })
      .then(() => {
        setState({ status: 'done' });
        void queryClient.invalidateQueries({ queryKey: authKeys.me });
      })
      .catch((reason: unknown) => setState({ status: 'failed', message: errorMessage(reason) }));
  }, [token, navigate, queryClient]);

  const home = (
    <Link to="/" className="font-medium text-brand-soft hover:underline">
      Continue to ZIPTV
    </Link>
  );

  if (state.status === 'working') {
    return (
      <AuthShell title="Confirming your email">
        <Spinner label="One moment…" />
      </AuthShell>
    );
  }
  if (state.status === 'done') {
    return (
      <AuthShell title="Email confirmed" footer={home}>
        <div className="flex gap-3 text-sm text-fg-muted">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
          <p role="status">Thank you. If you ever forget your password, we can now reach you at this address.</p>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="This link does not work"
      footer={
        <>
          Signed in? Request a new link in{' '}
          <Link to="/settings" className="font-medium text-brand-soft hover:underline">
            Settings
          </Link>
          .
        </>
      }
    >
      <FormError>{state.message}</FormError>
    </AuthShell>
  );
}
