import { LogIn, LogOut, Settings, User, UserPlus } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';

import { IconButton } from '../../../components/ui/Button';
import { Popover } from '../../../components/ui/Popover';
import { useSessionStore } from '../../session/session';
import { signOut } from '../sign-out';

const ITEM = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg-muted hover:bg-fg/5 hover:text-fg';

/** Top-bar account button: who is signed in, or an invitation to sign in / register as a guest. */
export function UserMenu() {
  const account = useSessionStore((s) => s.account);
  const navigate = useNavigate();
  const here = useLocation();
  const from = `${here.pathname}${here.search}`;

  return (
    <Popover
      trigger={({ toggle, open }) => (
        <IconButton label={account ? `Account: ${account.email}` : 'Account (guest)'} active={open} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
          <User className="h-5 w-5" />
        </IconButton>
      )}
      className="w-64 p-1.5"
    >
      {(close) => (
        <div role="menu">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-fg">{account ? account.email : 'Guest'}</p>
            <p className="text-xs text-fg-subtle">{account ? 'Signed in' : 'Data is stored on this device only'}</p>
          </div>
          <div className="my-1 border-t border-line/5" />
          {!account && (
            <>
              <Link to="/register" state={{ from }} onClick={close} className={ITEM} role="menuitem">
                <UserPlus className="h-4 w-4" /> Create account
              </Link>
              <Link to="/login" state={{ from }} onClick={close} className={ITEM} role="menuitem">
                <LogIn className="h-4 w-4" /> Sign in
              </Link>
            </>
          )}
          <Link to="/settings" onClick={close} className={ITEM} role="menuitem">
            <Settings className="h-4 w-4" /> Settings
          </Link>
          {account && (
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={async () => {
                close();
                await signOut();
                navigate('/', { replace: true });
              }}
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
