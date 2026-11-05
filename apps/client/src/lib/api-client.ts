import type { ApiErrorBody, ApiErrorCode } from "@ziptv/contracts";

import { resolveApiUrl } from "../config";
import { i18n, t, type TKey } from "../i18n";

export type ClientErrorCode = ApiErrorCode | "NETWORK_ERROR" | "ABORTED";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
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
export function configureContextHeaders(
  provider: () => Record<string, string>,
): void {
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

export interface ProfileGate {
  profileId: string;
  reason: "kids_lock" | "pin_required";
}

type GateRecoveryHandler = (gate: ProfileGate) => Promise<boolean>;

let recoverGate: GateRecoveryHandler = async () => false;

export function configureGateRecovery(handler: GateRecoveryHandler): void {
  recoverGate = handler;
}

function getProfileGate(error: ApiError): ProfileGate | null {
  if (error.status !== 403) return null;

  if (!error.details || typeof error.details !== "object") {
    return null;
  }

  const details = error.details as Record<string, unknown>;

  if (typeof details.profileId !== "string" || !details.profileId.trim()) {
    return null;
  }

  if (details.reason !== "kids_lock" && details.reason !== "pin_required") {
    return null;
  }

  return {
    profileId: details.profileId,
    reason: details.reason,
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Plain objects are sent as JSON, FormData as multipart. */
  body?: unknown;
  signal?: AbortSignal;
  /** Default true. */
  auth?: boolean;
  gateRecovery?: boolean;
  /**
   * Default true: a 401 means "my token is dead", so a new session is obtained and the request is
   * repeated. Sign-in requests must turn this off: for them a 401 means "wrong password", and
   * renewing a session in response would silently replace the person's identity.
   */
  renewOn401?: boolean;
  /** Let the request outlive the page (final playback event when the tab closes). */
  keepalive?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options, options.auth !== false);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

interface RetryState {
  token: boolean;
  profile: boolean;
  gate: boolean;
}

async function send(
  path: string,
  options: RequestOptions,
  withAuth: boolean,
  retries: RetryState = {
    token: false,
    profile: false,
    gate: false,
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(withAuth ? contextHeaders() : {}),
  };

  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const token = withAuth ? authProvider?.getToken() : null;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  headers["Accept-Language"] = i18n.locale;

  let response: Response;

  try {
    response = await fetch(resolveApiUrl(path), {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, "ABORTED", "Request was cancelled.");
    }

    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Cannot reach the ZIPTV server. Check your connection and try again.",
    );
  }

  // 1. Recover expired authentication token.
  if (
    response.status === 401 &&
    withAuth &&
    options.renewOn401 !== false &&
    !retries.token &&
    authProvider
  ) {
    await authProvider.renewToken();

    return send(path, options, withAuth, {
      ...retries,
      token: true,
    });
  }

  if (!response.ok) {
    const error = await toApiError(response);

    // 2. Recover from a protected profile gate.
    if (withAuth && options.gateRecovery !== false && !retries.gate) {
      const gate = getProfileGate(error);

      if (gate) {
        const recovered = await recoverGate(gate);

        if (recovered) {
          return send(path, options, withAuth, {
            ...retries,
            gate: true,
          });
        }
      }
    }

    // 3. Recover a deleted profile for read requests only.
    const read = (options.method ?? "GET") === "GET";

    if (
      read &&
      withAuth &&
      !retries.profile &&
      error.status === 404 &&
      (error.details as { reason?: unknown } | undefined)?.reason ===
        "profile" &&
      recoverProfile()
    ) {
      return send(path, options, withAuth, {
        ...retries,
        profile: true,
      });
    }

    throw error;
  }

  return response;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error) {
      return new ApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.details,
        body.error.requestId,
      );
    }
  } catch {
    // Non-JSON error (proxy/CDN page) — fall through.
  }
  return new ApiError(
    response.status,
    response.status >= 500 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
    `Server responded with HTTP ${response.status}.`,
  );
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return apiErrorMessage(error);
  if (error instanceof Error) return error.message;
  return t("common.somethingWrong");
}

/**
 * The server explains failures in English, with a stable `code`. In English that explanation is
 * shown as it is (it is the most specific); in the other languages the code's translation is,
 * falling back to the server's words for a code the client does not know yet.
 */
function apiErrorMessage(error: ApiError): string {
  if (error.code === "NETWORK_ERROR") return t("errors.network");
  if (error.code === "ABORTED") return t("errors.aborted");
  if (i18n.locale === "en") return error.message;
  const key = `errors.code.${error.code}` as TKey;
  const translated = t(key);
  return translated === key ? error.message : translated;
}
