import type { CatchupInfo } from '../../domain/catalog/model.js';

/**
 * Persistence ports for playlists (the user's editable channel lists).
 * Two ports because they change for different reasons: the playlist/group structure, and the
 * (much larger, bulk-edited) entries.
 */

export interface PlaylistRecord {
  id: string;
  ownerId: string;
  name: string;
  exportEnabled: boolean;
  /** SHA-256 of the current export link token (null = no link). Never sent to clients. */
  exportTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaylistSummaryRecord extends PlaylistRecord {
  entryCount: number;
  groupCount: number;
}

export interface GroupRecord {
  id: string;
  playlistId: string;
  name: string;
  position: number;
  entryCount: number;
}

export interface PlaylistRepository {
  countByOwner(ownerId: string): Promise<number>;
  create(playlist: { id: string; ownerId: string; name: string }): Promise<PlaylistRecord>;
  list(ownerId: string): Promise<PlaylistSummaryRecord[]>;
  findOwned(id: string, ownerId: string): Promise<PlaylistRecord | null>;
  rename(id: string, ownerId: string, name: string): Promise<PlaylistRecord | null>;
  /** Deletes the playlist with its groups and entries. */
  deleteOwned(id: string, ownerId: string): Promise<boolean>;

  /** `null` disables the export link. `hash` finds the playlist from a link; `sealed` lets its owner read the link again. */
  setExportToken(id: string, ownerId: string, token: { hash: string; sealed: string } | null): Promise<boolean>;
  getExportTokenSealed(id: string, ownerId: string): Promise<string | null>;
  findByExportTokenHash(hash: string): Promise<PlaylistRecord | null>;

  /** In display order. */
  listGroups(playlistId: string): Promise<GroupRecord[]>;
  /** `null` when a group with this name (case-insensitive) exists. Added after the last group. */
  createGroup(playlistId: string, id: string, name: string): Promise<GroupRecord | null>;
  renameGroup(playlistId: string, groupId: string, name: string): Promise<'ok' | 'duplicate' | 'not_found'>;
  /** `groupIds` must be every group of the playlist exactly once; false otherwise. */
  reorderGroups(playlistId: string, groupIds: string[]): Promise<boolean>;
  /** Entries of the group move to the end of the ungrouped list, or are deleted. */
  deleteGroup(playlistId: string, groupId: string, deleteEntries: boolean): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------

/** `missing`: gone from the source. `unplayable`: the web player cannot play it (it may still export). */
export type EntryStatus = 'ok' | 'missing' | 'unplayable';

export interface EntryRecord {
  id: string;
  playlistId: string;
  groupId: string | null;
  position: number;
  number: number | null;
  name: string;
  logo: string | null;
  tvgId: string | null;
  sourceId: string;
  sourceName: string;
  sourceKey: string;
  status: EntryStatus;
}

/** Where a new entry goes: a group by name (created when absent), by id (must exist), or nowhere. */
export type GroupTarget = { name: string } | { id: string } | null;

export interface NewEntry {
  sourceId: string;
  sourceKey: string;
  /** The channel's normalised name when added — used to re-attach the entry if the provider re-groups it. */
  originNameKey: string;
  name: string;
  logo: string | null;
  tvgId: string | null;
  group: GroupTarget;
}

export type AddEntriesResult =
  | { status: 'ok'; added: number; skipped: number }
  | { status: 'full' }
  | { status: 'group_not_found' };

export interface EntryFilter {
  /** Entries of one group, or of no group. Omitted: all. */
  group?: { id: string } | 'ungrouped';
  /** Case-insensitive substring of the name. */
  search?: string;
  /** Only entries whose channel vanished from the source. */
  missingOnly?: boolean;
}

export interface EntryStats {
  total: number;
  missing: number;
  ungrouped: number;
}

export interface EntryPatch {
  name?: string;
  logo?: string | null;
  tvgId?: string | null;
  number?: number | null;
}

export type TransferPlacement = { by: 'name' } | { by: 'group'; groupId: string | null };

export type TransferResult = { status: 'ok'; transferred: number; skipped: number } | { status: 'full' } | { status: 'group_not_found' };

/** One playable line of an exported playlist. `locator` is still sealed. */
export interface ExportRow {
  name: string;
  number: number | null;
  logo: string | null;
  tvgId: string | null;
  groupName: string | null;
  locator: string;
  catchup: CatchupInfo | null;
}

export interface PlaylistEntryRepository {
  /** Idempotent: channels already in the playlist are skipped. New entries go after the existing ones of their group. */
  addEntries(playlistId: string, entries: NewEntry[], options: { maxEntries: number }): Promise<AddEntriesResult>;
  /** Display order: ungrouped first, then groups in order; entries by position. */
  list(playlistId: string, filter: EntryFilter, page: { offset: number; limit: number }): Promise<{ items: EntryRecord[]; total: number }>;
  stats(playlistId: string): Promise<EntryStats>;
  update(playlistId: string, entryId: string, patch: EntryPatch): Promise<EntryRecord | null>;
  /**
   * Moves entries to a group (null = ungrouped), keeping their relative order, before
   * `beforeEntryId` or at the end. Entries not in the playlist are ignored.
   */
  move(playlistId: string, entryIds: string[], target: { groupId: string | null; beforeEntryId: string | null }): Promise<{ moved: number } | 'group_not_found'>;
  remove(playlistId: string, entryIds: string[]): Promise<number>;
  /** Numbers every entry in display order. */
  renumber(playlistId: string, numbering: { start: number; step: number }): Promise<number>;
  /** Copies or moves entries between two playlists of the same owner (the caller checked ownership). */
  transfer(input: {
    fromPlaylistId: string;
    toPlaylistId: string;
    entryIds: string[] | 'all';
    mode: 'copy' | 'move';
    placement: TransferPlacement;
    maxEntries: number;
  }): Promise<TransferResult>;
  /** Re-attaches missing entries to the one channel that now has their name. Returns how many. */
  relink(scope: { playlistId: string } | { sourceId: string }): Promise<number>;
  /**
   * Entries that can be exported (their channel exists and has a stream URL), in display order,
   * in batches of at most `batchSize`. Reading is incremental: nothing is held between batches.
   */
  exportBatches(playlistId: string, batchSize: number): AsyncGenerator<ExportRow[]>;
}
