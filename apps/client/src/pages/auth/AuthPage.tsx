import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, LogIn, UserPlus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Brand } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';
import { authApi, useAuthFeatures } from '../../features/auth/api';
import { hasIssues, safeRedirect, validateLogin, validateRegistration, type FormIssues } from '../../features/auth/credentials';
import { useSessionStore } from '../../features/session/session';
import { usePlaylists } from '../../features/playlists/api';
import { sourceKeys, sourcesApi } from '../../features/sources/api';
import { ApiError, errorMessage } from '../../lib/api-client';

interface LocationState {
  from?: string;
  /** The previous session ended (sent here by the session gate). */
  expired?: boolean;
  email?: string;
  /** An informational line, e.g. after a password reset. */
  notice?: string;
}

/** Sign in or create an account. A guest that registers keeps everything it added. */
export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const state = (useLocation().state ?? {}) as LocationState;
  const navigate = useNavigate();
  const token = useSessionStore((s) => s.token);
  const account = useSessionStore((s) => s.account);
  const ids = { email: useId(), password: useId(), confirm: useId() };
  const features = useAuthFeatures();

  const [email, setEmail] = useState(state.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [merge, setMerge] = useState(true);
  const [issues, setIssues] = useState<FormIssues>({});
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);

  // What this device already holds as a guest — only asked while a guest session exists, so opening
  // this page never creates a session by itself.
  const guest = Boolean(token) && account === null;
  const sources = useQuery({ queryKey: sourceKeys.all, queryFn: ({ signal }) => sourcesApi.list(signal), enabled: guest });
  const playlists = usePlaylists(guest);
  const guestSources = sources.data?.length ?? 0;
  const guestPlaylists = playlists.data?.length ?? 0;
  const hasGuestData = guestSources + guestPlaylists > 0;

  if (token && account) return <Navigate to={safeRedirect(state.from)} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = mode === 'login' ? validateLogin({ email, password }) : validateRegistration({ email, password, confirm });
    setIssues(found);
    if (hasIssues(found)) return;

    setPending(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await authApi.login({ email: email.trim(), password, // Not conditional on what has loaded so far: sources and playlists arrive as two requests, and a quick
          // click must not skip the merge. With nothing to bring it only retires the empty guest identity.
          ...(guest && merge ? { mergeGuest: true } : {}) })
          : await authApi.register({ email: email.trim(), password });
      useSessionStore.getState().setAccount(result.token, result.user.email ?? email.trim().toLowerCase());
      toast.success(mode === 'login' ? 'Signed in' : 'Account created', { description: result.user.email ?? undefined });
      navigate(safeRedirect(state.from), { replace: true });
    } catch (reason) {
      setError({ message: errorMessage(reason), ...(reason instanceof ApiError ? { code: reason.code } : {}) });
      setPending(false);
    }
  };

  const isLogin = mode === 'login';
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Brand />
        </div>

        <div className="card space-y-5 p-5 sm:p-6">
          <div>
            <h1 className="text-xl font-bold text-fg">{isLogin ? 'Sign in' : 'Create your account'}</h1>
            <p className="mt-1 text-sm text-fg-muted">
              {isLogin ? 'Your sources and playlists, on every device.' : guestSources + guestPlaylists > 0 ? 'Everything you have added on this device stays with you.' : 'Keep your sources and playlists across devices.'}
            </p>
          </div>

          {state.notice && isLogin && (
            <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
              {state.notice}
            </p>
          )}

          {state.expired && isLogin && (
            <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
              Your session ended. Sign in again to continue — nothing was lost.
            </p>
          )}

          <form onSubmit={submit} noValidate className="space-y-4">
            <Field id={ids.email} label="Email" issue={issues.email}>
              <input id={ids.email} type="email" inputMode="email" autoComplete="email" autoFocus={!state.email} spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} className="field" aria-invalid={Boolean(issues.email)} />
            </Field>

            <Field id={ids.password} label="Password" issue={issues.password}>
              <div className="relative">
                <input
                  id={ids.password}
                  type={reveal ? 'text' : 'password'}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  autoFocus={Boolean(state.email)}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field pr-11"
                  aria-invalid={Boolean(issues.password)}
                />
                <button type="button" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide password' : 'Show password'} className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-fg/10 hover:text-fg">
                  {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {!isLogin && !issues.password && <p className="text-xs text-fg-subtle">At least 8 characters.</p>}
              {isLogin && features.data?.passwordReset && (
                <p className="text-xs">
                  <Link to="/forgot-password" state={{ from: state.from }} className="text-brand-soft hover:underline">
                    Forgot your password?
                  </Link>
                </p>
              )}
            </Field>

            {!isLogin && (
              <Field id={ids.confirm} label="Repeat the password" issue={issues.confirm}>
                <input id={ids.confirm} type={reveal ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="field" aria-invalid={Boolean(issues.confirm)} />
              </Field>
            )}

            {isLogin && guest && hasGuestData && (
              <label className="flex items-start gap-2.5 rounded-lg bg-fg/5 p-3 text-sm text-fg">
                <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
                <span>
                  Bring what is on this device into my account
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    {[guestSources > 0 && `${guestSources} ${guestSources === 1 ? 'source' : 'sources'}`, guestPlaylists > 0 && `${guestPlaylists} ${guestPlaylists === 1 ? 'playlist' : 'playlists'}`].filter(Boolean).join(' and ')}
                  </span>
                </span>
              </label>
            )}

            {error && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
                <p>{error.message}</p>
                {error.code === 'EMAIL_TAKEN' && (
                  <p className="mt-1">
                    <Link to="/login" state={{ from: state.from, email }} className="font-medium underline">
                      Sign in instead
                    </Link>
                  </p>
                )}
                {(error.code === 'SOURCE_LIMIT_REACHED' || error.code === 'PLAYLIST_LIMIT_REACHED') && merge && (
                  <p className="mt-1">
                    <button type="button" className="font-medium underline" onClick={() => { setMerge(false); setError(null); }}>
                      Sign in without bringing them
                    </button>
                  </p>
                )}
              </div>
            )}

            <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full" icon={isLogin ? <LogIn className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}>
              {isLogin ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>

        <p className="text-center text-sm text-fg-muted">
          {isLogin ? 'New here? ' : 'Already have an account? '}
          <Link to={isLogin ? '/register' : '/login'} state={{ from: state.from }} className="font-medium text-brand-soft hover:underline">
            {isLogin ? 'Create an account' : 'Sign in'}
          </Link>
        </p>
        {guest && (
          <p className="text-center text-xs text-fg-subtle">
            <Link to={safeRedirect(state.from)} className="hover:underline">
              Continue without an account
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ id, label, issue, children }: { id: string; label: string; issue: string | undefined; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm text-fg-muted">
        {label}
      </label>
      {children}
      {issue && (
        <p role="alert" className="text-sm text-red-500">
          {issue}
        </p>
      )}
    </div>
  );
}
