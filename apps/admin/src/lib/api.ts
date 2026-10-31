import type { ApiErrorBody, ApiErrorCode } from '@ziptv/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const STORAGE_KEY = 'ziptv.console.token';
type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

/**
 * The console session token. sessionStorage: it dies with the tab (a console left open in a
 * shared browser does not survive a restart), and it is never sent automatically like a cookie.
 */
export const consoleSession = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null): void {
    try {
      if (token) sessionStorage.setItem(STORAGE_KEY, token);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage blocked: the session lasts for this page only */
    }
    for (const listener of listeners) listener(token);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = consoleSession.token;
  let response: Response;
  try {
    response = await fetch(`/admin/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : null,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The console server cannot be reached.');
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    // An expired/revoked session: back to sign-in (sign-in steps themselves keep their error).
    if (response.status === 401 && token && !path.startsWith('/auth/')) consoleSession.set(null);
    throw new ApiError(response.status, error?.code ?? 'INTERNAL_ERROR', error?.message ?? `Request failed (${response.status})`, error?.details);
  }
  return body as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
