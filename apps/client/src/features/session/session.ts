import type { SessionDto } from '@ziptv/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { ApiError, apiRequest, configureAuth } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { resetProfileSelection } from '../profiles/profile-store';
import { persistentStorage, readRawStorage, removeRawStorage } from '../../lib/storage';
import { needsSignIn, onUnauthorized, type SessionSnapshot } from './session-policy';

const SESSION_STORAGE_KEY = 'ziptv:session';

interface SessionState extends SessionSnapshot {
  /** A guest: the anonymous identity every device starts with. */
  setGuest: (token: string) => void;
  /** Signed in or registered. Everything cached for the previous identity is dropped. */
  setAccount: (token: string, email: string) => void;
  /** The server rejected the token. An account keeps its email (so the app asks to sign in); a guest is just empty. */
  dropToken: () => void;
  /**
   * Forget the identity and everything cached for it. `signedOut` (the default) sends the next
   * protected screen to the sign-in page; false (e.g. the account was deleted) to the welcome page.
   */
  clear: (signedOut?: boolean) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      account: null,
      signedOut: false,
      setGuest: (token) => set({ token, account: null, signedOut: false }),
      setAccount: (token, email) => {
        set({ token, account: { email }, signedOut: false });
        resetProfileSelection();
        queryClient.clear();
      },
      dropToken: () => set({ token: null }),
      clear: (signedOut = true) => {
        set({ token: null, account: null, signedOut });
        resetProfileSelection();
        queryClient.clear();
      },
    }),
    {
      name: SESSION_STORAGE_KEY,
      storage: persistentStorage,
      version: 2,
      // v1 stored only the token of an anonymous session.
      migrate: (persisted) => ({ token: (persisted as { token?: string | null } | null)?.token ?? null, account: null }),
      partialize: (state) => ({ token: state.token, account: state.account, signedOut: state.signedOut }),
    },
  ),
);

/** Where the 1.x client (redux-persist) kept its guest id. */
const LEGACY_STORAGE_KEY = 'persist:root';

let pending: Promise<string> | null = null;

/**
 * Returns the current token, starting a guest if the device has none. Called when the person chose
 * "Continue as guest", or to restore a 1.x guest — never just because a screen was opened.
 */
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
  installSessionSync();
  configureAuth({
    getToken: () => useSessionStore.getState().token,
    renewToken: () => {
      // Several requests can hit 401 together: the first starts the new guest, the rest wait for it
      // (by then the token is already dropped, which would otherwise read as "no session").
      if (pending) return pending;
      const state = useSessionStore.getState();
      const action = onUnauthorized(state);
      state.dropToken();
      if (action === 'sign-in') return Promise.reject(signInRequired());
      if (action === 'none') return Promise.reject(noSession());
      return renewSession();
    },
  });
}

/**
 * Keeps every tab of this browser on the same identity. The session lives in localStorage, which
 * other tabs only see on reload: without this, signing out in one tab would leave another tab
 * signed in on screen (its requests failing), and signing in as someone else would show the
 * previous person's cached data there.
 */
export function installSessionSync(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SESSION_STORAGE_KEY && event.key !== null) return; // null: the whole storage was cleared
    const before = useSessionStore.getState();
    const settle = () => {
      const after = useSessionStore.getState();
      if (after.token === before.token && after.account?.email === before.account?.email) return;
      resetProfileSelection();
      queryClient.clear();
    };
    // Removed (or storage cleared) in another tab: nothing to rehydrate from, so forget here too.
    if (event.newValue === null) {
      useSessionStore.setState({ token: null, account: null, signedOut: true });
      settle();
      return;
    }
    void Promise.resolve(useSessionStore.persist.rehydrate()).then(settle);
  };
  target.addEventListener('storage', onStorage as EventListener);
  return () => target.removeEventListener('storage', onStorage as EventListener);
}

/** A 1.x guest id is on this device: its data is restored without asking anything. */
export const hasLegacyGuest = (): boolean => readLegacySecretId() !== null;

function noSession(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Sign in or continue as a guest to use ZIPTV.');
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
