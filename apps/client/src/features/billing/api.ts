import type {
  AccountBillingDto,
  CheckoutQuoteDto,
  CheckoutStartedDto,
  CheckoutStatusDto,
  DeviceDto,
  PackageOfferDto,
  PlanChangeQuoteDto,
  PlaybackHeartbeatDto,
  PlaybackSessionDto,
  RegisterDeviceRequest,
  StartPlaybackSessionRequest,
  SubscriptionDto,
} from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { redirectTo } from '../../lib/redirect';
import { operatorKeys } from '../operator/api';
import { currentDeviceId } from './device';

export const billingApi = {
  packages: (signal?: AbortSignal) => apiRequest<PackageOfferDto[]>('/api/v1/billing/packages', { signal }),
  startCheckout: (input: { packageId: string; promoCode?: string }) => apiRequest<CheckoutStartedDto>('/api/v1/billing/checkout', { method: 'POST', body: input }),
  quote: (input: { packageId: string; promoCode?: string }) => apiRequest<CheckoutQuoteDto>('/api/v1/billing/quote', { method: 'POST', body: input }),
  changeQuote: (packageId: string) => apiRequest<PlanChangeQuoteDto>('/api/v1/billing/subscription/change/quote', { method: 'POST', body: { packageId } }),
  changePlan: (packageId: string) => apiRequest<SubscriptionDto>('/api/v1/billing/subscription/change', { method: 'POST', body: { packageId } }),
  checkout: (id: string, signal?: AbortSignal) => apiRequest<CheckoutStatusDto>(`/api/v1/billing/checkout/${encodeURIComponent(id)}`, { signal }),
  account: (deviceId: string | null, signal?: AbortSignal) => apiRequest<AccountBillingDto>(`/api/v1/billing/account${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`, { signal }),
  cancel: () => apiRequest<SubscriptionDto>('/api/v1/billing/subscription/cancel', { method: 'POST', body: {} }),
  resume: () => apiRequest<SubscriptionDto>('/api/v1/billing/subscription/resume', { method: 'POST', body: {} }),
  registerDevice: (body: RegisterDeviceRequest) => apiRequest<DeviceDto>('/api/v1/devices', { method: 'POST', body }),
  revokeDevice: (id: string) => apiRequest<void>(`/api/v1/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  startSession: (body: StartPlaybackSessionRequest) => apiRequest<PlaybackSessionDto>('/api/v1/operator/playback/sessions', { method: 'POST', body }),
  heartbeat: (id: string) => apiRequest<PlaybackHeartbeatDto>(`/api/v1/operator/playback/sessions/${encodeURIComponent(id)}/heartbeat`, { method: 'POST', body: {} }),
  /** keepalive: also sent while the tab closes, so the stream slot is freed at once. */
  stopSession: (id: string, keepalive = false) => apiRequest<void>(`/api/v1/operator/playback/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive }),
};

export const billingKeys = {
  all: ['billing'] as const,
  packages: ['billing', 'packages'] as const,
  account: ['billing', 'account'] as const,
  checkout: (id: string) => ['billing', 'checkout', id] as const,
};

export function usePackages() {
  return useQuery({ queryKey: billingKeys.packages, queryFn: ({ signal }) => billingApi.packages(signal), staleTime: 60_000 });
}

export function useAccountBilling(enabled = true) {
  return useQuery({ queryKey: billingKeys.account, queryFn: ({ signal }) => billingApi.account(currentDeviceId(), signal), enabled, staleTime: 0, refetchInterval: 30_000 });
}

/** Sends the browser to the processor's hosted payment page. */
export function useStartCheckout() {
  return useMutation({
    mutationFn: billingApi.startCheckout,
    onSuccess: (started) => {
      redirectTo(started.redirectUrl);
    },
  });
}

/**
 * The checkout after the processor sent the browser back. Polls until the server has *verified*
 * the payment (webhook or processor query) — coming back is not proof of anything.
 */
export function useCheckoutStatus(id: string | null) {
  return useQuery({
    queryKey: billingKeys.checkout(id ?? ''),
    queryFn: ({ signal }) => billingApi.checkout(id!, signal),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === 'open' ? 2_000 : false),
    retry: 1,
  });
}

/** Everything that depends on the viewer's entitlements: plans, account, the lock marks of the channel list. */
function useInvalidateCommerce() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: billingKeys.all }), client.invalidateQueries({ queryKey: operatorKeys.all })]);
}

/** Moves the subscription to another plan now (prorated by the processor). */
export function useChangePlan() {
  const invalidate = useInvalidateCommerce();
  return useMutation({ mutationFn: billingApi.changePlan, onSettled: invalidate });
}

export function useCancelSubscription() {
  const invalidate = useInvalidateCommerce();
  return useMutation({ mutationFn: billingApi.cancel, onSettled: invalidate });
}

export function useResumeSubscription() {
  const invalidate = useInvalidateCommerce();
  return useMutation({ mutationFn: billingApi.resume, onSettled: invalidate });
}

export function useRevokePlaybackDevice() {
  const invalidate = useInvalidateCommerce();
  return useMutation({ mutationFn: billingApi.revokeDevice, onSettled: invalidate });
}

export function useStopPlayback() {
  const invalidate = useInvalidateCommerce();
  return useMutation({ mutationFn: (id: string) => billingApi.stopSession(id), onSettled: invalidate });
}

export { useInvalidateCommerce };
