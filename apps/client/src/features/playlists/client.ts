import type {
  AddEntriesResultDto,
  AddFromSourceRequest,
  CreateGroupRequest,
  MergePlaylistsRequest,
  MoveEntriesRequest,
  PlaylistDto,
  PlaylistEntryDto,
  PlaylistEntryPageDto,
  PlaylistExportDto,
  PlaylistGroupDto,
  PlaylistSummaryDto,
  RelinkResultDto,
  RenumberRequest,
  RenumberResultDto,
  TransferEntriesRequest,
  TransferEntriesResultDto,
  UpdateEntryRequest,
} from '@ziptv/contracts';

import { apiRequest } from '../../lib/api-client';
import { entriesQuery, type EntryFilter } from './entry-filter';

const BASE = '/api/v1/playlists';

/** Plain HTTP calls (no React), one per endpoint of the playlists API. */
export const playlistsApi = {
  list: (signal?: AbortSignal) => apiRequest<PlaylistSummaryDto[]>(BASE, { signal }),
  create: (name: string) => apiRequest<PlaylistDto>(BASE, { method: 'POST', body: { name } }),
  get: (id: string, signal?: AbortSignal) => apiRequest<PlaylistDto>(`${BASE}/${id}`, { signal }),
  rename: (id: string, name: string) => apiRequest<PlaylistDto>(`${BASE}/${id}`, { method: 'PATCH', body: { name } }),
  remove: (id: string) => apiRequest<void>(`${BASE}/${id}`, { method: 'DELETE' }),

  enableExport: (id: string) => apiRequest<PlaylistExportDto>(`${BASE}/${id}/export`, { method: 'POST' }),
  disableExport: (id: string) => apiRequest<void>(`${BASE}/${id}/export`, { method: 'DELETE' }),

  createGroup: (id: string, body: CreateGroupRequest) => apiRequest<PlaylistGroupDto>(`${BASE}/${id}/groups`, { method: 'POST', body }),
  renameGroup: (id: string, groupId: string, name: string) => apiRequest<void>(`${BASE}/${id}/groups/${groupId}`, { method: 'PATCH', body: { name } }),
  reorderGroups: (id: string, groupIds: string[]) => apiRequest<void>(`${BASE}/${id}/groups/order`, { method: 'PUT', body: { groupIds } }),
  deleteGroup: (id: string, groupId: string, deleteEntries: boolean) => apiRequest<void>(`${BASE}/${id}/groups/${groupId}?entries=${deleteEntries ? 'delete' : 'keep'}`, { method: 'DELETE' }),

  entries: (id: string, filter: EntryFilter, page: { offset: number; limit: number }, signal?: AbortSignal) =>
    apiRequest<PlaylistEntryPageDto>(`${BASE}/${id}/entries?${entriesQuery(filter, page)}`, { signal }),
  addFromSource: (id: string, body: AddFromSourceRequest) => apiRequest<AddEntriesResultDto>(`${BASE}/${id}/entries/from-source`, { method: 'POST', body }),
  updateEntry: (id: string, entryId: string, body: UpdateEntryRequest) => apiRequest<PlaylistEntryDto>(`${BASE}/${id}/entries/${entryId}`, { method: 'PATCH', body }),
  move: (id: string, body: MoveEntriesRequest) => apiRequest<{ moved: number }>(`${BASE}/${id}/entries/move`, { method: 'POST', body }),
  removeEntries: (id: string, entryIds: string[]) => apiRequest<{ removed: number }>(`${BASE}/${id}/entries`, { method: 'DELETE', body: { entryIds } }),
  transfer: (id: string, body: TransferEntriesRequest) => apiRequest<TransferEntriesResultDto>(`${BASE}/${id}/entries/transfer`, { method: 'POST', body }),
  merge: (id: string, body: MergePlaylistsRequest) => apiRequest<TransferEntriesResultDto>(`${BASE}/${id}/merge`, { method: 'POST', body }),
  renumber: (id: string, body: RenumberRequest) => apiRequest<RenumberResultDto>(`${BASE}/${id}/renumber`, { method: 'POST', body }),
  relink: (id: string) => apiRequest<RelinkResultDto>(`${BASE}/${id}/relink`, { method: 'POST' }),
};
