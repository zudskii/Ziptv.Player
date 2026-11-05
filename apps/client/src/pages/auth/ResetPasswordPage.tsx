import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { Button } from '../../components/ui/Button';
import { authApi } from '../../features/auth/api';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../../features/auth/credentials';
import { tokenFromFragment } from '../../features/auth/email-links';
import { ApiError, errorMessage } from '../../lib/api-client';
import { AuthShell, FormError } from './AuthShell';
import { t } from '../../i18n';

/** Choose a new password with the link from the email (its token is in the URL fragment). */
export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const ids = { password: useId(), confirm: useId() };
  // Read once, then taken out of the address bar and the history: the secret should not outlive this screen.
  const [token] = useState(() => tokenFromFragment(location.hash));
  useEffect(() => {
    if (token) navigate({ hash: '' }, { replace: true });
  }, [token, navigate]);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [issues, setIssues] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<{ message: string; invalid: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  const again = (
    <Link to="/forgot-password" className="font-medium text-brand-soft hover:underline">
      {t('auth.requestLink')}
    </Link>
  );

  if (!token) {
    return (
      <AuthShell title={t('auth.linkBroken')} footer={again}>
        <FormError>{t('auth.linkDamaged')}</FormError>
      </AuthShell>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: { password?: string; confirm?: string } = {};
    const problem = passwordProblem(password);
    if (problem) found.password = problem;
    else if (confirm !== password) found.confirm = t('auth.validation.mismatch');
    setIssues(found);
    if (Object.keys(found).length > 0) return;

    setPending(true);
    setError(null);
    try {
      await authApi.resetPassword({ token, password });
      navigate('/login', { replace: true, state: { notice: t('auth.passwordChangedSignIn') } });
    } catch (reason) {
      setError({ message: errorMessage(reason), invalid: reason instanceof ApiError && reason.code === 'INVALID_TOKEN' });
      setPending(false);
    }
  };

  return (
    <AuthShell title={t('auth.chooseNew')} subtitle="You will be signed out everywhere and can sign in with the new password." footer={error?.invalid ? again : undefined}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={ids.password} className="text-sm text-fg-muted">
            {t('auth.newPassword')}
          </label>
          <input id={ids.password} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className="field" aria-invalid={Boolean(issues.password)} />
          {issues.password ? (
            <p role="alert" className="text-sm text-red-500">
              {issues.password}
            </p>
          ) : (
            <p className="text-xs text-fg-subtle">{t('auth.atLeast', { count: MIN_PASSWORD_LENGTH })}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.confirm} className="text-sm text-fg-muted">
            {t('auth.repeatNew')}
          </label>
          <input id={ids.confirm} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="field" aria-invalid={Boolean(issues.confirm)} />
          {issues.confirm && (
            <p role="alert" className="text-sm text-red-500">
              {issues.confirm}
            </p>
          )}
        </div>
        {error && <FormError>{error.message}</FormError>}
        <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
          {t('auth.changePassword')}
        </Button>
      </form>
    </AuthShell>
  );
}
