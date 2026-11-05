import { KeyRound, LogIn, LogOut, Monitor, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { errorMessage } from '../../../lib/api-client';
import { toast } from 'sonner';

import { useSessionStore } from '../../session/session';
import { useAuthFeatures, useMe, useSendVerification } from '../api';
import { signOut } from '../sign-out';
import { ChangePasswordDialog, DeleteAccountDialog, DevicesDialog } from './AccountDialogs';
import { t, tx } from '../../../i18n';

type Dialog = 'devices' | 'password' | 'delete' | null;

/** Settings → Account: guest invitation, or the signed-in account's email, devices and password. */
export function AccountSection() {
  const account = useSessionStore((s) => s.account);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [signingOut, setSigningOut] = useState(false);
  const features = useAuthFeatures();
  const me = useMe(account !== null);
  const sendVerification = useSendVerification();

  if (!account) {
    return (
      <section className="card space-y-3 p-4" aria-labelledby="account">
        <h2 id="account" className="font-semibold text-fg">
          {t('auth.account')}
        </h2>
        <p className="text-sm text-fg-muted">
          {t('auth.guestNotice')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/register" state={{ from: '/settings' }}>
            <Button variant="primary" icon={<UserPlus className="h-4 w-4" />}>
              {t('auth.createAccount')}
            </Button>
          </Link>
          <Link to="/login" state={{ from: '/settings' }}>
            <Button icon={<LogIn className="h-4 w-4" />}>{t('auth.signIn')}</Button>
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="card space-y-4 p-4" aria-labelledby="account">
      <div>
        <h2 id="account" className="font-semibold text-fg">
          {t('auth.account')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {tx('auth.signedInAs', { email: account.email, b: (chunks) => <span className="font-medium text-fg">{chunks}</span> })}
        </p>
        {features.data?.emailVerification && me.data && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {me.data.emailVerified ? (
              <Badge tone="success">{t('auth.emailConfirmed')}</Badge>
            ) : (
              <>
                <Badge tone="warning">{t('auth.emailNotConfirmed')}</Badge>
                <button
                  type="button"
                  disabled={sendVerification.isPending}
                  className="text-brand-soft hover:underline disabled:opacity-60"
                  onClick={() =>
                    sendVerification.mutate(undefined, {
                      onSuccess: () => toast.success(t('auth.linkSent'), { description: `Check ${account.email}.` }),
                      onError: (reason) => toast.error(errorMessage(reason)),
                    })
                  }
                >
                  {t('auth.sendMeLink')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button icon={<Monitor className="h-4 w-4" />} onClick={() => setDialog('devices')}>
          {t('auth.devices')}
        </Button>
        <Button icon={<KeyRound className="h-4 w-4" />} onClick={() => setDialog('password')}>
          {t('auth.changePassword')}
        </Button>
        <Button
          icon={<LogOut className="h-4 w-4" />}
          loading={signingOut}
          onClick={async () => {
            setSigningOut(true);
            await signOut();
            // The session gate takes every screen (and every tab) to the sign-in page.
          }}
        >
          {t('auth.signOut')}
        </Button>
        <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDialog('delete')}>
          {t('auth.deleteAccount')}
        </Button>
      </div>
      <DevicesDialog open={dialog === 'devices'} onClose={() => setDialog(null)} />
      <ChangePasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} />
      <DeleteAccountDialog open={dialog === 'delete'} onClose={() => setDialog(null)} />
    </section>
  );
}
