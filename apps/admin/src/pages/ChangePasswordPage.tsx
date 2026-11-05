import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { Button, ErrorNote, Field, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../i18n';

export function ChangePasswordPage() {
  const { me } = useAuth();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== repeat) return setError(new Error(t('password.mismatch')));
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      await client.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md">
      <PageHeader
        title={me?.mustChangePassword ? t('password.choose') : t('password.change')}
        description={me?.mustChangePassword ? t('password.temporary') : t('password.othersOut')}
      />
      <form onSubmit={submit} className="card space-y-4 p-5">
        <Field label={me?.mustChangePassword ? t('password.temporaryLabel') : t('password.current')} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field label={t('password.new')} type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} hint={t('password.minLength')} />
        <Field label={t('password.repeat')} type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        <ErrorNote error={error} />
        <Button tone="primary" type="submit" busy={busy}>
          {t('password.save')}
        </Button>
      </form>
    </div>
  );
}
