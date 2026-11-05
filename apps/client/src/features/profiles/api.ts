import type { CreateProfileRequest, ProfileDto, ProfileLibraryDto, UpdateProfileLibraryRequest, UpdateProfileRequest } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { useProfileStore } from './profile-store';

const BASE = '/api/v1/profiles';
export const profileKeys = { all: ['profiles'] as const, library: (id: string) => ['profiles', id, 'library'] as const };

export function useProfiles() {
  return useQuery({ queryKey: profileKeys.all, queryFn: ({ signal }) => apiRequest<ProfileDto[]>(BASE, { signal }), staleTime: 60_000 });
}

/** The profile requests are made as (the selected one, else the kids profile this device is held in, else the default). */
export function useActiveProfile(): ProfileDto | undefined {
  const profiles = useProfiles().data;
  const selected = useProfileStore((state) => state.profileId);
  return profiles?.find((profile) => profile.id === selected) ?? profiles?.find((profile) => profile.heldHere) ?? profiles?.find((profile) => profile.isDefault);
}

export function useCreateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProfileRequest) => apiRequest<ProfileDto>(BASE, { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProfileRequest }) => apiRequest<ProfileDto>(`${BASE}/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: profileKeys.all }),
  });
}

export function useDeleteProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pin }: { id: string; pin?: string }) => apiRequest<void>(`${BASE}/${id}`, { method: 'DELETE', body: pin ? { pin } : {} }),
    onSuccess: (_result, { id }) => {
      if (useProfileStore.getState().profileId === id) useProfileStore.getState().select(null);
      return client.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

/** The account's sources this profile sees (Profile → Library). */
export function useProfileLibrary(id: string | undefined) {
  return useQuery({
    queryKey: profileKeys.library(id ?? 'none'),
    queryFn: ({ signal }) => apiRequest<ProfileLibraryDto>(`${BASE}/${id}/library`, { signal }),
    enabled: Boolean(id),
  });
}

/** Saving a library changes what the profile shows everywhere: every query is refreshed. */
export function useSetProfileLibrary() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProfileLibraryRequest & { id: string }) => apiRequest<ProfileLibraryDto>(`${BASE}/${id}/library`, { method: 'PUT', body }),
    onSuccess: () => client.invalidateQueries(),
  });
}
