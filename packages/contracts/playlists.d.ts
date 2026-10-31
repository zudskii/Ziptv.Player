/**
 * Playlists: the user's own, editable channel lists.
 *
 * A *source* is where channels come from (a provider's M3U, an uploaded file) and is read-only.
 * A *playlist* is what the user builds from one or more sources: which channels, in which groups
 * and order, with which names and numbers. Entries point at source channels, so stream URLs
 * (which providers rotate) stay current, while everything the user edited stays in the playlist.
 * A playlist can be exported as an M3U link for any player.
 */

/** `missing`: the source no longer has this channel. `unplayable`: the web player cannot play it. */
export type PlaylistEntryStatus = 'ok' | 'missing' | 'unplayable';

export interface PlaylistSummaryDto {
  id: string;
  name: string;
  entryCount: number;
  groupCount: number;
  exportEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistGroupDto {
  id: string;
  name: string;
  /** Order of the group within the playlist (ascending). */
  position: number;
  entryCount: number;
}

export interface PlaylistExportDto {
  enabled: boolean;
  /** The M3U link, present while export is enabled. Treat it like a password. */
  url: string | null;
}

export interface PlaylistDto extends PlaylistSummaryDto {
  groups: PlaylistGroupDto[];
  /** Entries that are in no group (listed before all groups). */
  ungroupedCount: number;
  /** Entries whose channel disappeared from its source. */
  missingCount: number;
  export: PlaylistExportDto;
}

export interface PlaylistEntryDto {
  id: string;
  /** null = not in any group. */
  groupId: string | null;
  /** Order within its group (ascending). */
  position: number;
  /** Channel number (`tvg-chno`); null = none. */
  number: number | null;
  name: string;
  logo: string | null;
  tvgId: string | null;
  sourceId: string;
  sourceName: string;
  /** The channel's key in its source (what the image proxy needs). */
  sourceKey: string;
  status: PlaylistEntryStatus;
}

export interface PlaylistEntryPageDto {
  items: PlaylistEntryDto[];
  total: number;
  offset: number;
  limit: number;
}

// --- requests --------------------------------------------------------------------------------

export interface CreatePlaylistRequest {
  name: string;
}

export interface RenamePlaylistRequest {
  name: string;
}

export interface CreateGroupRequest {
  name: string;
}

export interface RenameGroupRequest {
  name: string;
}

/** Every group of the playlist, in the new order. */
export interface ReorderGroupsRequest {
  groupIds: string[];
}

export type AddSelection =
  | { type: 'all' }
  /** Every channel of these source groups (case-insensitive names). */
  | { type: 'groups'; groups: string[] }
  | { type: 'keys'; keys: string[] };

export type AddPlacement =
  /** One playlist group per source group (created as needed); channels without a group stay ungrouped. */
  | { type: 'sourceGroups' }
  | { type: 'group'; groupId: string }
  | { type: 'ungrouped' };

/** Idempotent: channels already in the playlist are skipped, so "add all" also picks up new ones. */
export interface AddFromSourceRequest {
  sourceId: string;
  select: AddSelection;
  placement: AddPlacement;
}

export interface AddEntriesResultDto {
  added: number;
  /** Already in the playlist. */
  skipped: number;
}

export interface UpdateEntryRequest {
  name?: string;
  /** null clears it. */
  logo?: string | null;
  tvgId?: string | null;
  number?: number | null;
}

export interface MoveEntriesRequest {
  entryIds: string[];
  /** Target group; null = ungrouped. */
  groupId: string | null;
  /** Insert before this entry of the target group; omitted/null = at the end. */
  beforeEntryId?: string | null;
}

export interface RemoveEntriesRequest {
  entryIds: string[];
}

export interface TransferEntriesRequest {
  /** Entries of the playlist in the URL, or 'all'. */
  entryIds: string[] | 'all';
  toPlaylistId: string;
  mode: 'copy' | 'move';
  /**
   * Where they land. Omitted: keep their group names (groups are created in the target as
   * needed). `{ groupId }`: put them all in that group (null = ungrouped).
   */
  group?: { groupId: string | null };
}

export interface TransferEntriesResultDto {
  transferred: number;
  /** Already in the target playlist. */
  skipped: number;
}

/** Copy everything (groups and entries) of other playlists into the playlist in the URL. */
export interface MergePlaylistsRequest {
  sourcePlaylistIds: string[];
}

export interface RenumberRequest {
  /** First number (default 1). */
  start?: number;
  /** Increment (default 1). */
  step?: number;
}

export interface RenumberResultDto {
  renumbered: number;
}

export interface RelinkResultDto {
  /** Missing entries re-attached to the channel that replaced them. */
  relinked: number;
  stillMissing: number;
}
