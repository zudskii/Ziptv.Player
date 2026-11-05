import { MailCheck } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { authApi, useAuthFeatures } from '../../features/auth/api';
import { emailProblem } from '../../features/auth/credentials';
import { errorMessage } from '../../lib/api-client';
import { AuthShell, FormError } from './AuthShell';
import { t, tx } from '../../i18n';

/** Asks for a reset link. The answer is the same whether or not the address is registered. */
export function ForgotPasswordPage() {
  const id = useId();
  const features = useAuthFeatures();
  const [email, setEmail] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = emailProblem(email);
    setIssue(problem);
    if (problem) return;
    setPending(true);
    setError(null);
    try {
      await authApi.forgotPassword({ email: email.trim() });
      setSentTo(email.trim());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const back = (
    <Link to="/login" className="font-medium text-brand-soft hover:underline">
      {t('auth.backToSignIn')}
    </Link>
  );

  if (sentTo) {
    return (
      <AuthShell title={t('auth.checkEmail')} footer={back}>
        <div className="flex gap-3 text-sm text-fg-muted">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-soft" aria-hidden />
          <p role="status">
            {tx('auth.sentTo', { email: sentTo, b: (chunks) => <span className="font-medium text-fg">{chunks}</span> })}
          </p>
        </div>
        <p className="text-xs text-fg-subtle">{t('auth.nothingArrived')}</p>
      </AuthShell>
    );
  }

  const unavailable = features.isSuccess && !features.data.passwordReset;
  return (
    <AuthShell title={t('auth.forgot')} subtitle="Enter your email and we will send you a link to choose a new one." footer={back}>
      {unavailable ? (
        <FormError>{t('auth.noMail')}</FormError>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={id} className="text-sm text-fg-muted">
              {t('auth.email')}
            </label>
            <input id={id} type="email" inputMode="email" autoComplete="email" autoFocus spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} className="field" aria-invalid={Boolean(issue)} />
            {issue && (
              <p role="alert" className="text-sm text-red-500">
                {issue}
              </p>
            )}
          </div>
          {error && <FormError>{error}</FormError>}
          <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
            {t('auth.sendLink')}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
