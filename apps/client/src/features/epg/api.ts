import type {
  AddGuideRequest,
  ChannelEpgLinkDto,
  ChannelScheduleDto,
  EpgSearchResultDto,
  GuideChannelOptionDto,
  GuideDto,
  GuideSourceDto,
  NowNextListDto,
  SetEpgMappingRequest,
  SourceDto,
  UpdateGuideRequest,
} from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { sourceKeys } from '../sources/api';

const BASE = '/api/v1/epg';

/** Version of everything programme-related of a source: links (catalogVersion) + guide data. */
export function epgVersion(source: SourceDto): string {
  return `${source.catalogVersion}:${source.epg.version}`;
}

export const epgKeys = {
  nowNext: (sourceId: string, version: string) => ['epg', 'now', sourceId, version] as const,
  schedule: (sourceId: string, key: string, version: string) => ['epg', 'schedule', sourceId, key, version] as const,
  guide: (sourceId: string, version: string, from: string, to: string, group: string, offset: number, limit: number) =>
    ['epg', 'guide', sourceId, version, from, to, group, offset, limit] as const,
  guides: ['epg', 'guides'] as const,
  link: (sourceId: string, key: string) => ['epg', 'link', sourceId, key] as const,
};

/** Now/next for every linked channel of a source; refreshed every minute (programme changes). */
export function useNowNext(source: SourceDto | undefined) {
  return useQuery({
    queryKey: source ? epgKeys.nowNext(source.id, epgVersion(source)) : ['epg', 'now', 'none'],
    queryFn: ({ signal }) => apiRequest<NowNextListDto>(`${BASE}/now?sourceId=${source!.id}`, { signal }),
    enabled: Boolean(source && source.revision > 0 && source.stats.epgMapped > 0),
    staleTime: 55_000,
    refetchInterval: 60_000,
    placeholderData: (previous) => (previous && previous.sourceId === source?.id ? previous : undefined),
  });
}

export function useChannelSchedule(source: SourceDto | undefined, channelKey: string | undefined, enabled = true) {
  return useQuery({
    queryKey: source && channelKey ? epgKeys.schedule(source.id, channelKey, epgVersion(source)) : ['epg', 'schedule', 'none'],
    queryFn: ({ signal }) => apiRequest<ChannelScheduleDto>(`${BASE}/channels/${source!.id}/${channelKey}`, { signal }),
    enabled: Boolean(enabled && source && channelKey),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

/** One page of TV Guide rows (channels `offset`…`offset+limit`) for a time window. */
export function guideGridQuery(input: { source: SourceDto; from: number; to: number; group: string; offset: number; limit: number }) {
  const { source, group, offset, limit } = input;
  const from = new Date(input.from).toISOString();
  const to = new Date(input.to).toISOString();
  return {
    queryKey: epgKeys.guide(source.id, epgVersion(source), from, to, group, offset, limit),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const params = new URLSearchParams({ sourceId: source.id, from, to, offset: String(offset), limit: String(limit) });
      if (group) params.set('group', group);
      return apiRequest<GuideDto>(`${BASE}/guide?${params.toString()}`, { signal });
    },
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  };
}

export function useEpgSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['epg', 'search', q],
    queryFn: ({ signal }) => apiRequest<EpgSearchResultDto>(`${BASE}/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}

// --- guides (EPG sources) ---------------------------------------------------------------------

export function useGuides() {
  return useQuery({
    queryKey: epgKeys.guides,
    queryFn: ({ signal }) => apiRequest<GuideSourceDto[]>(`${BASE}/guides`, { signal }),
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.some((guide) => guide.sync.status === 'queued' || guide.sync.status === 'running') ? 2_000 : 60_000),
  });
}

function useInvalidateEpg() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['epg'] });
    void queryClient.invalidateQueries({ queryKey: sourceKeys.all });
  };
}

export function useAddGuide() {
  const invalidate = useInvalidateEpg();
  return useMutation({ mutationFn: (input: AddGuideRequest) => apiRequest<GuideSourceDto>(`${BASE}/guides`, { method: 'POST', body: input }), onSuccess: invalidate });
}

export function useUpdateGuide() {
  const invalidate = useInvalidateEpg();
  return useMutation({
    mutationFn: (input: { id: string; patch: UpdateGuideRequest }) => apiRequest<GuideSourceDto>(`${BASE}/guides/${input.id}`, { method: 'PATCH', body: input.patch }),
    onSuccess: invalidate,
  });
}

export function useRemoveGuide() {
  const invalidate = useInvalidateEpg();
  return useMutation({ mutationFn: (id: string) => apiRequest<void>(`${BASE}/guides/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
}

export function useSyncGuide() {
  const invalidate = useInvalidateEpg();
  return useMutation({ mutationFn: (id: string) => apiRequest<GuideSourceDto>(`${BASE}/guides/${id}/sync`, { method: 'POST' }), onSuccess: invalidate });
}

// --- mapping ------------------------------------------------------------------------------------

export function useEpgLink(sourceId: string, channelKey: string, enabled: boolean) {
  return useQuery({
    queryKey: epgKeys.link(sourceId, channelKey),
    queryFn: ({ signal }) => apiRequest<ChannelEpgLinkDto>(`${BASE}/links/${sourceId}/${channelKey}`, { signal }),
    enabled,
  });
}

export function useGuideChannelSearch(sourceId: string, query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['epg', 'guide-channels', sourceId, query.trim()],
    queryFn: ({ signal }) => apiRequest<GuideChannelOptionDto[]>(`${BASE}/guide-channels?sourceId=${sourceId}&q=${encodeURIComponent(query.trim())}`, { signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useSetMapping() {
  const invalidate = useInvalidateEpg();
  return useMutation({ mutationFn: (input: SetEpgMappingRequest) => apiRequest<ChannelEpgLinkDto>(`${BASE}/mappings`, { method: 'PUT', body: input }), onSuccess: invalidate });
}

export function useRemoveMapping() {
  const invalidate = useInvalidateEpg();
  return useMutation({
    mutationFn: (input: { sourceId: string; channelKey: string }) => apiRequest<ChannelEpgLinkDto>(`${BASE}/mappings/${input.sourceId}/${input.channelKey}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
