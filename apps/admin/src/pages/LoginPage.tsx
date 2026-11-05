import type { AdminLoginResponse, AdminSessionDto } from '@ziptv/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { Button, ErrorNote, Field } from '../components/ui';
import { api, consoleSession } from '../lib/api';
import { t } from '../i18n';
import { LanguagePicker } from '../components/LanguagePicker';

/** Password → (first time: enrol an authenticator) → 6-digit code. */
export function LoginPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<AdminLoginResponse | null>(null);
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (step?.step === 'enroll') void QRCode.toDataURL(step.otpauthUri, { margin: 1, width: 192 }).then(setQr);
  }, [step]);

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStep(await api<AdminLoginResponse>('/auth/login', { method: 'POST', body: { email, password } }));
      setPassword('');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api<AdminSessionDto>('/auth/mfa', { method: 'POST', body: { challenge: step.challenge, code } });
      client.setQueryData(['me', session.token], session.me);
      consoleSession.set(session.token);
      navigate(session.me.mustChangePassword ? '/password' : '/', { replace: true });
    } catch (failure) {
      setError(failure);
      setCode('');
      if (failure instanceof Error && /Sign in again|expired/.test(failure.message)) setStep(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <div>
            <h1 className="font-semibold">{t('login.title')}</h1>
            <p className="text-xs text-fg-muted">{t('login.subtitle')}</p>
          </div>
          <div className="ml-auto">
            <LanguagePicker />
          </div>
        </div>

        {!step && (
          <form onSubmit={submitPassword} className="space-y-4">
            <Field label={t('login.email')} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Field label={t('login.password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <ErrorNote error={error} />
            <Button tone="primary" type="submit" busy={busy} className="w-full">
              <KeyRound className="h-4 w-4" aria-hidden /> {t('login.continue')}
            </Button>
          </form>
        )}

        {step && (
          <form onSubmit={submitCode} className="space-y-4">
            {step.step === 'enroll' ? (
              <div className="space-y-3 text-sm">
                <p className="text-fg-muted">{t('login.enrol')}</p>
                {qr && <img src={qr} alt={t('login.qr')} className="mx-auto rounded-lg bg-white p-2" width={192} height={192} />}
                <p className="text-xs text-fg-subtle">
                  {t('login.manualKey')} <code className="break-all font-mono text-fg">{step.secret}</code>
                </p>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{t('login.enterCode')}</p>
            )}
            <Field
              label={t('login.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <ErrorNote error={error} />
            <Button tone="primary" type="submit" busy={busy} className="w-full">
              <ShieldCheck className="h-4 w-4" aria-hidden /> {t('login.verify')}
            </Button>
            <button type="button" className="w-full text-center text-xs text-fg-muted hover:text-fg" onClick={() => setStep(null)}>
              {t('login.startOver')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
