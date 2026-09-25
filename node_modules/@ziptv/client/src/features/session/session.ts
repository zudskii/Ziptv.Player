import type { SessionDto } from '@ziptv/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { apiRequest, configureAuth } from '../../lib/api-client';
import { persistentStorage, readRawStorage, removeRawStorage } from '../../lib/storage';

interface SessionState {
  token: string | null;
  setToken: (token: string | null) => void;
}

export const useSessionStore = create<SessionState>()(
  persist((set) => ({ token: null, setToken: (token) => set({ token }) }), {
    name: 'ziptv:session',
    storage: persistentStorage,
    version: 1,
  }),
);

/** Where the 1.x client (redux-persist) kept its guest id. */
const LEGACY_STORAGE_KEY = 'persist:root';

let pending: Promise<string> | null = null;

/** Returns the current token, creating an anonymous session on first visit. */
export function ensureSession(): Promise<string> {
  const token = useSessionStore.getState().token;
  return token ? Promise.resolve(token) : renewSession();
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
  useSessionStore.getState().setToken(session.token);
  // The old id is a one-time ticket either way; never send it again.
  if (legacySecretId) removeRawStorage(LEGACY_STORAGE_KEY);
  return session.token;
}

export function installSessionAuth(): void {
  configureAuth({
    getToken: () => useSessionStore.getState().token,
    renewToken: () => {
      useSessionStore.getState().setToken(null);
      return renewSession();
    },
  });
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
