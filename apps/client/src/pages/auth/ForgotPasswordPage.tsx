import { MailCheck } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { authApi, useAuthFeatures } from '../../features/auth/api';
import { emailProblem } from '../../features/auth/credentials';
import { errorMessage } from '../../lib/api-client';
import { AuthShell, FormError } from './AuthShell';

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
      Back to sign in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthShell title="Check your email" footer={back}>
        <div className="flex gap-3 text-sm text-fg-muted">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-soft" aria-hidden />
          <p role="status">
            If an account exists for <span className="font-medium text-fg">{sentTo}</span>, we have sent a link to choose a new password. It works once and expires in an hour.
          </p>
        </div>
        <p className="text-xs text-fg-subtle">Nothing arrived? Check the spam folder, or try again with the address you registered with.</p>
      </AuthShell>
    );
  }

  const unavailable = features.isSuccess && !features.data.passwordReset;
  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email and we will send you a link to choose a new one." footer={back}>
      {unavailable ? (
        <FormError>This server is not set up to send email, so passwords cannot be reset here. Ask whoever runs it.</FormError>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={id} className="text-sm text-fg-muted">
              Email
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
            Send the link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
