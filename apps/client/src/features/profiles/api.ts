import type { CreateProfileRequest, ProfileDto, UpdateProfileRequest } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { useProfileStore } from './profile-store';

const BASE = '/api/v1/profiles';
export const profileKeys = { all: ['profiles'] as const };

export function useProfiles() {
  return useQuery({ queryKey: profileKeys.all, queryFn: ({ signal }) => apiRequest<ProfileDto[]>(BASE, { signal }), staleTime: 60_000 });
}

/** The profile requests are made as (the selected one, else the default). */
export function useActiveProfile(): ProfileDto | undefined {
  const profiles = useProfiles().data;
  const selected = useProfileStore((state) => state.profileId);
  return profiles?.find((profile) => profile.id === selected) ?? profiles?.find((profile) => profile.isDefault);
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
    mutationFn: (id: string) => apiRequest<void>(`${BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      if (useProfileStore.getState().profileId === id) useProfileStore.getState().select(null);
      return client.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}
