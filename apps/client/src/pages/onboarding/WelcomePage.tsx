import { Clapperboard, LayoutGrid, LogIn, MonitorPlay, Tv, UserPlus, UserRound } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { Brand } from '../../components/layout/Brand';
import { Button, ButtonLink } from '../../components/ui/Button';
import { safeRedirect } from '../../features/auth/credentials';
import { ensureSession, useSessionStore } from '../../features/session/session';
import { errorMessage } from '../../lib/api-client';

/**
 * The public front door, shown to a device without a session. Nothing is created until the person
 * picks one of the three ways in; with a session already, it is never shown (straight back in).
 */
export function WelcomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = useSessionStore((state) => state.token);
  const from = (location.state as { from?: unknown } | null)?.from;
  const next = safeRedirect(from);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Navigate to={next} replace />;

  const continueAsGuest = async () => {
    setPending(true);
    setError(null);
    try {
      await ensureSession();
      navigate(next, { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgb(59_130_246/0.18),transparent)] px-4 py-10">
      <div className="mb-8">
        <Brand />
      </div>
      <main className="card w-full max-w-lg p-6 text-center shadow-2xl sm:p-8">
        <h1 className="text-3xl font-bold tracking-tight text-fg">Welcome to ZIPTV</h1>
        <p className="mt-3 text-fg-muted">Your personal streaming hub: Live TV with a programme guide, movies and series — all from your own sources.</p>
        <ul className="mx-auto mt-6 grid max-w-sm grid-cols-2 gap-3 text-left text-sm text-fg-muted">
          <Feature icon={<Tv className="h-4 w-4" />}>Live TV</Feature>
          <Feature icon={<LayoutGrid className="h-4 w-4" />}>TV Guide</Feature>
          <Feature icon={<Clapperboard className="h-4 w-4" />}>Movies</Feature>
          <Feature icon={<MonitorPlay className="h-4 w-4" />}>Series</Feature>
        </ul>

        <div className="mt-8 space-y-2">
          <ButtonLink to="/register" state={{ from }} variant="primary" size="lg" className="w-full" icon={<UserPlus className="h-5 w-5" />}>
            Create an account
          </ButtonLink>
          <ButtonLink to="/login" state={{ from }} size="lg" className="w-full" icon={<LogIn className="h-5 w-5" />}>
            Sign in
          </ButtonLink>
          <Button variant="ghost" size="lg" className="w-full" loading={pending} icon={<UserRound className="h-5 w-5" />} onClick={() => void continueAsGuest()}>
            Continue as guest
          </Button>
          <p className="text-xs text-fg-subtle">As a guest, what you add stays on this device. Create an account later to keep it everywhere.</p>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}

function Feature({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-fg/5 px-3 py-2">
      <span className="text-brand-soft">{icon}</span>
      {children}
    </li>
  );
}
