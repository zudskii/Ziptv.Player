import type { StaffMeDto, StaffPermission } from '@ziptv/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { api, consoleSession } from './api';

interface AuthState {
  me: StaffMeDto | null;
  loading: boolean;
  can: (permission: StaffPermission) => boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const token = useSyncExternalStore(consoleSession.subscribe, () => consoleSession.token);
  const me = useQuery({ queryKey: ['me', token], queryFn: () => api<StaffMeDto>('/me'), enabled: token !== null, retry: false, staleTime: 60_000 });

  // A new identity must never see the previous one's cached data.
  useEffect(() => {
    if (token === null) client.clear();
  }, [token, client]);

  const value = useMemo<AuthState>(() => {
    const current = token ? (me.data ?? null) : null;
    return {
      me: current,
      loading: token !== null && me.isPending,
      can: (permission) => current !== null && !current.mustChangePassword && current.permissions.includes(permission),
      signOut: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        consoleSession.set(null);
      },
    };
  }, [token, me.data, me.isPending]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error('useAuth outside AuthProvider');
  return state;
}
