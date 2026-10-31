import type { AuthFeaturesDto, AuthSessionDto, ChangePasswordRequest, DeleteAccountRequest, ForgotPasswordRequest, LoginRequest, MeDto, RegisterRequest, ResetPasswordRequest, SessionInfoDto, VerifyEmailRequest } from '@ziptv/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';

const BASE = '/api/v1/auth';

/**
 * Sign-in requests send the current (guest) token so the server can upgrade or merge it, but a 401
 * from them means "wrong password" — never "my session died" — so they must not renew the session.
 */
export const authApi = {
  register: (body: RegisterRequest) => apiRequest<AuthSessionDto>(`${BASE}/register`, { method: 'POST', body, renewOn401: false }),
  login: (body: LoginRequest) => apiRequest<AuthSessionDto>(`${BASE}/login`, { method: 'POST', body, renewOn401: false }),
  logout: () => apiRequest<void>(`${BASE}/logout`, { method: 'POST', renewOn401: false }),
  sessions: (signal?: AbortSignal) => apiRequest<SessionInfoDto[]>(`${BASE}/sessions`, { signal }),
  revokeSession: (id: string) => apiRequest<void>(`${BASE}/sessions/${id}`, { method: 'DELETE' }),
  changePassword: (body: ChangePasswordRequest) => apiRequest<void>(`${BASE}/password`, { method: 'POST', body }),
  deleteAccount: (body: DeleteAccountRequest) => apiRequest<void>(`${BASE}/account`, { method: 'DELETE', body }),

  // Public: opened from an email, often on a device with no session. They must never start one
  // (auth: false), and a 401-like answer must never renew one.
  features: (signal?: AbortSignal) => apiRequest<AuthFeaturesDto>(`${BASE}/features`, { signal, auth: false }),
  forgotPassword: (body: ForgotPasswordRequest) => apiRequest<Record<string, never>>(`${BASE}/forgot-password`, { method: 'POST', body, auth: false }),
  resetPassword: (body: ResetPasswordRequest) => apiRequest<void>(`${BASE}/reset-password`, { method: 'POST', body, auth: false }),
  verifyEmail: (body: VerifyEmailRequest) => apiRequest<void>(`${BASE}/verify-email`, { method: 'POST', body, auth: false }),
  sendVerification: () => apiRequest<Record<string, never>>(`${BASE}/send-verification`, { method: 'POST', body: {} }),
  me: (signal?: AbortSignal) => apiRequest<MeDto>('/api/v1/sessions/me', { signal }),
};

export const authKeys = { sessions: ['auth', 'sessions'] as const, features: ['auth', 'features'] as const, me: ['auth', 'me'] as const };

export function useDevices(enabled: boolean) {
  return useQuery({ queryKey: authKeys.sessions, queryFn: ({ signal }) => authApi.sessions(signal), enabled, staleTime: 0 });
}

export function useRevokeDevice() {
  return useMutation({ mutationFn: authApi.revokeSession });
}

export function useChangePassword() {
  return useMutation({ mutationFn: authApi.changePassword });
}

export function useDeleteAccount() {
  return useMutation({ mutationFn: authApi.deleteAccount });
}

/** What this server can do by email. While unknown (or if the call fails) nothing email-related is offered. */
export function useAuthFeatures() {
  return useQuery({ queryKey: authKeys.features, queryFn: ({ signal }) => authApi.features(signal), staleTime: 5 * 60_000, retry: false });
}

/** The signed-in account as the server sees it (for "email confirmed"). Only asked for accounts. */
export function useMe(enabled: boolean) {
  return useQuery({ queryKey: authKeys.me, queryFn: ({ signal }) => authApi.me(signal), enabled, staleTime: 60_000 });
}

export function useSendVerification() {
  return useMutation({ mutationFn: authApi.sendVerification });
}
