import { Smartphone, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Spinner } from '../../../components/ui/Spinner';
import { errorMessage } from '../../../lib/api-client';
import { formatAgo } from '../../../lib/time';
import { useSessionStore } from '../../session/session';
import { useChangePassword, useDeleteAccount, useDevices, useRevokeDevice } from '../api';
import { describeDevice, hasIssues, passwordProblem } from '../credentials';

interface DialogProps {
  open: boolean;
  onClose: () => void;
}

/** Every device signed in to this account, with a way to sign the others out. */
export function DevicesDialog({ open, onClose }: DialogProps) {
  const devices = useDevices(open);
  const revoke = useRevokeDevice();

  return (
    <Dialog open={open} onClose={onClose} title="Signed-in devices" description="Sign out any device you do not recognise.">
      {devices.isPending ? (
        <Spinner className="py-8" />
      ) : devices.isError ? (
        <p role="alert" className="text-sm text-red-500">
          {errorMessage(devices.error)}
        </p>
      ) : (
        <ul className="divide-y divide-line/5">
          {(devices.data ?? []).map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-3">
              <Smartphone className="h-5 w-5 shrink-0 text-fg-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <span className="truncate">{describeDevice(device.userAgent)}</span>
                  {device.current && <Badge tone="brand">This device</Badge>}
                </p>
                <p className="text-xs text-fg-muted">Last active {formatAgo(device.lastSeenAt)}</p>
              </div>
              {!device.current && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={revoke.isPending && revoke.variables === device.id}
                  onClick={() =>
                    revoke.mutate(device.id, {
                      onSuccess: () => {
                        toast.success('Device signed out');
                        void devices.refetch();
                      },
                      onError: (reason) => toast.error(errorMessage(reason)),
                    })
                  }
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function ChangePasswordDialog({ open, onClose }: DialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Change password" description="Other devices are signed out when you change it.">
      {open && <ChangePasswordForm onClose={onClose} />}
    </Dialog>
  );
}

function ChangePasswordForm({ onClose }: { onClose: () => void }) {
  const email = useSessionStore((s) => s.account?.email ?? '');
  const change = useChangePassword();
  const ids = { current: useId(), next: useId(), confirm: useId() };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [issues, setIssues] = useState<{ next?: string; confirm?: string }>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: { next?: string; confirm?: string } = {};
    const problem = passwordProblem(next, email);
    if (problem) found.next = problem;
    else if (confirm !== next) found.confirm = 'The passwords do not match.';
    setIssues(found);
    if (hasIssues(found)) return;
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      toast.success('Password changed', { description: 'Your other devices were signed out.' });
      onClose();
    } catch {
      /* shown below */
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Row id={ids.current} label="Current password">
        <input id={ids.current} type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} className="field" />
      </Row>
      <Row id={ids.next} label="New password" issue={issues.next} hint="At least 8 characters.">
        <input id={ids.next} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="field" />
      </Row>
      <Row id={ids.confirm} label="Repeat the new password" issue={issues.confirm}>
        <input id={ids.confirm} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="field" />
      </Row>
      {change.error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {errorMessage(change.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={change.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || !next || !confirm}>
          Change password
        </Button>
      </div>
    </form>
  );
}

export function DeleteAccountDialog({ open, onClose }: DialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Delete account" description="This removes your sources, playlists and every saved setting. It cannot be undone.">
      {open && <DeleteAccountForm onClose={onClose} />}
    </Dialog>
  );
}

function DeleteAccountForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const remove = useDeleteAccount();
  const id = useId();
  const [password, setPassword] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await remove.mutateAsync({ password });
      useSessionStore.getState().clear();
      toast.success('Your account was deleted');
      navigate('/', { replace: true });
    } catch {
      /* shown below */
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Row id={id} label="Enter your password to confirm">
        <input id={id} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className="field" />
      </Row>
      {remove.error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {errorMessage(remove.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" loading={remove.isPending} disabled={!password} icon={<Trash2 className="h-4 w-4" />}>
          Delete my account
        </Button>
      </div>
    </form>
  );
}

function Row({ id, label, issue, hint, children }: { id: string; label: string; issue?: string | undefined; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm text-fg-muted">
        {label}
      </label>
      {children}
      {issue ? (
        <p role="alert" className="text-sm text-red-500">
          {issue}
        </p>
      ) : (
        hint && <p className="text-xs text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}
