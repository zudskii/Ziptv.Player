import type { SessionDto } from '@ziptv/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { ApiError, apiRequest, configureAuth } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { resetProfileSelection } from '../profiles/profile-store';
import { persistentStorage, readRawStorage, removeRawStorage } from '../../lib/storage';
import { needsSignIn, onUnauthorized, type SessionSnapshot } from './session-policy';

interface SessionState extends SessionSnapshot {
  /** A guest: the anonymous identity every device starts with. */
  setGuest: (token: string) => void;
  /** Signed in or registered. Everything cached for the previous identity is dropped. */
  setAccount: (token: string, email: string) => void;
  /** The server rejected the token. An account keeps its email (so the app asks to sign in); a guest is just empty. */
  dropToken: () => void;
  /** Signed out on purpose: forget the account too, the next visit starts a fresh guest. */
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      account: null,
      setGuest: (token) => set({ token, account: null }),
      setAccount: (token, email) => {
        set({ token, account: { email } });
        resetProfileSelection();
        queryClient.clear();
      },
      dropToken: () => set({ token: null }),
      clear: () => {
        set({ token: null, account: null });
        resetProfileSelection();
        queryClient.clear();
      },
    }),
    {
      name: 'ziptv:session',
      storage: persistentStorage,
      version: 2,
      // v1 stored only the token of an anonymous session.
      migrate: (persisted) => ({ token: (persisted as { token?: string | null } | null)?.token ?? null, account: null }),
      partialize: (state) => ({ token: state.token, account: state.account }),
    },
  ),
);

/** Where the 1.x client (redux-persist) kept its guest id. */
const LEGACY_STORAGE_KEY = 'persist:root';

let pending: Promise<string> | null = null;

/** Returns the current token, creating an anonymous session on first visit. */
export function ensureSession(): Promise<string> {
  const state = useSessionStore.getState();
  if (state.token) return Promise.resolve(state.token);
  // An account that lost its token must sign in; silently starting a guest would look like data loss.
  if (needsSignIn(state)) return Promise.reject(signInRequired());
  return renewSession();
}

/** Concurrent callers share one request (e.g. several queries hitting 401 at once). */
export function renewSession(): Promise<string> {
  pending ??= createSession().finally(() => {
    pending = null;
  });
  return pending;
}

async function createSession(): Promise<string> {
  const legacySecretId = readLegacySecretId();
  const session = await apiRequest<SessionDto>('/api/v1/sessions', {
    method: 'POST',
    body: legacySecretId ? { legacySecretId } : {},
    auth: false,
  });
  useSessionStore.getState().setGuest(session.token);
  // The old id is a one-time ticket either way; never send it again.
  if (legacySecretId) removeRawStorage(LEGACY_STORAGE_KEY);
  return session.token;
}

export function installSessionAuth(): void {
  configureAuth({
    getToken: () => useSessionStore.getState().token,
    renewToken: () => {
      const state = useSessionStore.getState();
      state.dropToken();
      if (onUnauthorized(state) === 'sign-in') return Promise.reject(signInRequired());
      return renewSession();
    },
  });
}

function signInRequired(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Your session has ended. Sign in again to continue.');
}

/** Reads `persist:root` → `user` → `userSecretId.secretId` written by the 1.x Redux store. */
export function readLegacySecretId(raw = readRawStorage(LEGACY_STORAGE_KEY)): string | null {
  if (!raw) return null;
  try {
    const root = JSON.parse(raw) as { user?: string };
    if (typeof root.user !== 'string') return null;
    const user = JSON.parse(root.user) as { userSecretId?: { secretId?: unknown } | null };
    const secretId = user.userSecretId?.secretId;
    return typeof secretId === 'string' && /^id\d{1,20}$/.test(secretId) ? secretId : null;
  } catch {
    return null;
  }
}
