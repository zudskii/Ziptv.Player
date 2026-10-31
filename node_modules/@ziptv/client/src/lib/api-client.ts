import type { ApiErrorBody, ApiErrorCode } from '@ziptv/contracts';

import { resolveApiUrl } from '../config';

export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'ABORTED';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Injected by the session feature (dependency inversion: the HTTP layer knows nothing about
 * how tokens are created or stored).
 */
export interface AuthProvider {
  getToken(): string | null;
  /** Called once on 401: obtain a fresh session token (deduplicated by the provider). */
  renewToken(): Promise<string>;
}

let authProvider: AuthProvider | null = null;
let contextHeaders: () => Record<string, string> = () => ({});

export function configureAuth(provider: AuthProvider): void {
  authProvider = provider;
}

/** Extra headers on every API call (active profile, parental unlock token). */
export function configureContextHeaders(provider: () => Record<string, string>): void {
  contextHeaders = provider;
}

let recoverProfile: () => boolean = () => false;

/**
 * Called when the server does not know the selected profile (deleted on another device):
 * the handler drops the selection and returns true, and the request is repeated once.
 */
export function configureProfileRecovery(handler: () => boolean): void {
  recoverProfile = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Plain objects are sent as JSON, FormData as multipart. */
  body?: unknown;
  signal?: AbortSignal;
  /** Default true. */
  auth?: boolean;
  /**
   * Default true: a 401 means "my token is dead", so a new session is obtained and the request is
   * repeated. Sign-in requests must turn this off: for them a 401 means "wrong password", and
   * renewing a session in response would silently replace the person's identity.
   */
  renewOn401?: boolean;
  /** Let the request outlive the page (final playback event when the tab closes). */
  keepalive?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options, options.auth !== false);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function send(path: string, options: RequestOptions, withAuth: boolean, isRetry = false): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(withAuth ? contextHeaders() : {}) };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const token = withAuth ? authProvider?.getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(resolveApiUrl(path), { method: options.method ?? 'GET', headers, body, signal: options.signal, ...(options.keepalive ? { keepalive: true } : {}) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new ApiError(0, 'ABORTED', 'Request was cancelled.');
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the ZIPTV server. Check your connection and try again.');
  }

  if (response.status === 401 && withAuth && options.renewOn401 !== false && !isRetry && authProvider) {
    await authProvider.renewToken();
    return send(path, options, withAuth, true);
  }
  if (!response.ok) {
    const error = await toApiError(response);
    // Reads only: a write meant for a deleted profile must not land on the default profile.
    const read = (options.method ?? 'GET') === 'GET';
    if (read && withAuth && !isRetry && error.status === 404 && (error.details as { reason?: unknown } | undefined)?.reason === 'profile' && recoverProfile()) {
      return send(path, options, withAuth, true);
    }
    throw error;
  }
  return response;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error) {
      return new ApiError(response.status, body.error.code, body.error.message, body.error.details, body.error.requestId);
    }
  } catch {
    // Non-JSON error (proxy/CDN page) — fall through.
  }
  return new ApiError(response.status, response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR', `Server responded with HTTP ${response.status}.`);
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
