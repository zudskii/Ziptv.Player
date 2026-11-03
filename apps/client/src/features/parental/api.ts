import type { ParentalSettingsDto, ProfileAccessDto, SetPinRequest, UnlockDto, UpdateParentalRulesRequest } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { profileKeys } from '../profiles/api';
import { useProfileStore } from '../profiles/profile-store';
import { askPin } from './pin-prompt';
import { profileKey, useParentalStore } from './parental-store';

const BASE = '/api/v1/me/parental';
export const parentalKeys = { settings: ['parental'] as const, of: (profileId: string | null) => ['parental', profileId ?? 'current'] as const };

/** PIN state and rules of the active profile (or, from a grown-up profile, of `profileId`). */
export function useParental(profileId: string | null = null) {
  return useQuery({
    queryKey: parentalKeys.of(profileId),
    queryFn: ({ signal }) => apiRequest<ParentalSettingsDto>(profileId ? `${BASE}?profileId=${encodeURIComponent(profileId)}` : BASE, { signal }),
    staleTime: 60_000,
  });
}

/** Everything depends on the restrictions: lists, flags, Home. */
function refreshAll(): Promise<void> {
  return queryClient.resetQueries();
}

export function useSetPin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetPinRequest) => apiRequest<ParentalSettingsDto>(`${BASE}/pin`, { method: 'PUT', body }),
    onSuccess: (settings) => {
      client.setQueryData(parentalKeys.of(null), settings);
      void client.invalidateQueries({ queryKey: parentalKeys.settings });
      // A new PIN voids every unlock.
      useParentalStore.getState().clear();
    },
  });
}

export function useRemovePin() {
  return useMutation({
    mutationFn: (pin: string) => apiRequest<ParentalSettingsDto>(`${BASE}/pin`, { method: 'DELETE', body: { pin } }),
    onSuccess: () => {
      useParentalStore.getState().clear();
      void refreshAll();
    },
  });
}

export function useUpdateRules() {
  return useMutation({
    mutationFn: (body: UpdateParentalRulesRequest) => apiRequest<ParentalSettingsDto>(`${BASE}/rules`, { method: 'PUT', body }),
    onSuccess: () => void refreshAll(),
  });
}

/** PIN → unlock token for the active profile (locked content plays for a while on this device). */
export async function unlockWithPin(pin: string): Promise<void> {
  const unlock = await apiRequest<UnlockDto>(`${BASE}/unlock`, { method: 'POST', body: { pin } });
  useParentalStore.getState().setUnlock(profileKey(useProfileStore.getState().profileId), { token: unlock.token, expiresAt: Date.parse(unlock.expiresAt) });
}

/** Asks for the PIN and unlocks locked content of the active profile; true when unlocked. */
export async function requestUnlock(): Promise<boolean> {
  const done = await askPin({ title: 'Enter the PIN', description: 'This content is locked by parental controls.', verify: unlockWithPin });
  // Lists show "locked" per request: refetch them (keeping what is on screen meanwhile).
  if (done) void queryClient.invalidateQueries();
  return done;
}

/**
 * Opens a profile on this device (`POST /profiles/:id/access`): asks for the PIN when the
 * profile is protected or the device is held in a kids profile, then selects it.
 */
export async function openProfile(profile: { id: string; isDefault: boolean }): Promise<boolean> {
  const access = (pin?: string) => apiRequest<ProfileAccessDto>(`/api/v1/profiles/${profile.id}/access`, { method: 'POST', body: pin ? { pin } : {} });
  try {
    await access();
  } catch (error) {
    if (!isPinRequired(error)) throw error;
    const done = await askPin({ title: 'Enter the PIN', description: 'This profile is protected by the parental PIN.', verify: async (pin) => void (await access(pin)) });
    if (!done) return false;
  }
  useProfileStore.getState().select(profile.isDefault ? null : profile.id);
  await queryClient.invalidateQueries({ queryKey: profileKeys.all });
  return true;
}

export function isPinRequired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'PIN_REQUIRED';
}
