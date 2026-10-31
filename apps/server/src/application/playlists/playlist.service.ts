import { createHash, randomBytes } from 'node:crypto';

import type { PlaylistDto, PlaylistGroupDto, PlaylistSummaryDto } from '@ziptv/contracts';

import { isEntityId, newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { SecretCipher } from '../ports/cipher.js';
import type { Logger } from '../ports/logger.js';
import type { GroupRecord, PlaylistEntryRepository, PlaylistRecord, PlaylistRepository } from '../ports/playlist-repository.js';

/**
 * What an export link serves:
 *   direct  — the upstream stream URLs (a user's own sources; whoever holds the link sees them);
 *   proxied — ZIPTV stream-proxy URLs tied to the link (revoking the link stops every stream);
 *   off     — no export links.
 */
export type PlaylistExportMode = 'direct' | 'proxied' | 'off';

/** Builds the public link for an export token (needs the origin of the request, so the caller supplies it). */
export type ExportLink = (token: string) => string;

const EXPORT_TOKEN_PURPOSE = 'playlist-export-token';
export const EXPORT_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function hashExportToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The playlists of a user and their groups, plus the public export link. Entries: PlaylistEntryService. */
export class PlaylistService {
  constructor(
    private readonly deps: {
      playlists: PlaylistRepository;
      entries: PlaylistEntryRepository;
      cipher: SecretCipher;
      limits: { maxPlaylistsPerUser: number };
      logger: Logger;
      /** `off`: export links cannot be created (operator deployments). */
      exportMode?: PlaylistExportMode;
      /** An export link stopped working (replaced or turned off): its proxied streams must stop too. */
      onExportRevoked?: (tokenHash: string) => void;
    },
  ) {}

  /** Throws 404 for a playlist that does not exist or belongs to someone else (the two look the same on purpose). */
  async require(ownerId: string, playlistId: string): Promise<PlaylistRecord> {
    const playlist = isEntityId(playlistId) ? await this.deps.playlists.findOwned(playlistId, ownerId) : null;
    if (!playlist) throw AppError.notFound('Playlist');
    return playlist;
  }

  async list(ownerId: string): Promise<PlaylistSummaryDto[]> {
    return (await this.deps.playlists.list(ownerId)).map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      entryCount: playlist.entryCount,
      groupCount: playlist.groupCount,
      exportEnabled: playlist.exportEnabled,
      createdAt: playlist.createdAt.toISOString(),
      updatedAt: playlist.updatedAt.toISOString(),
    }));
  }

  async create(ownerId: string, name: string, link: ExportLink): Promise<PlaylistDto> {
    if ((await this.deps.playlists.countByOwner(ownerId)) >= this.deps.limits.maxPlaylistsPerUser) {
      throw new AppError('PLAYLIST_LIMIT_REACHED', 409, `You can have up to ${this.deps.limits.maxPlaylistsPerUser} playlists. Delete one to create another.`);
    }
    const playlist = await this.deps.playlists.create({ id: newEntityId(), ownerId, name });
    return this.get(ownerId, playlist.id, link);
  }

  async get(ownerId: string, playlistId: string, link: ExportLink): Promise<PlaylistDto> {
    const playlist = await this.require(ownerId, playlistId);
    const [groups, stats, token] = await Promise.all([
      this.deps.playlists.listGroups(playlist.id),
      this.deps.entries.stats(playlist.id),
      this.exportToken(playlist),
    ]);
    return {
      id: playlist.id,
      name: playlist.name,
      entryCount: stats.total,
      groupCount: groups.length,
      exportEnabled: playlist.exportEnabled,
      createdAt: playlist.createdAt.toISOString(),
      updatedAt: playlist.updatedAt.toISOString(),
      groups: groups.map(toGroupDto),
      ungroupedCount: stats.ungrouped,
      missingCount: stats.missing,
      export: { enabled: playlist.exportEnabled, url: token ? link(token) : null },
    };
  }

  async rename(ownerId: string, playlistId: string, name: string, link: ExportLink): Promise<PlaylistDto> {
    if (!(await this.deps.playlists.rename(playlistId, ownerId, name))) throw AppError.notFound('Playlist');
    return this.get(ownerId, playlistId, link);
  }

  async remove(ownerId: string, playlistId: string): Promise<void> {
    if (!(await this.deps.playlists.deleteOwned(playlistId, ownerId))) throw AppError.notFound('Playlist');
  }

  // --- groups -------------------------------------------------------------------------------

  async createGroup(ownerId: string, playlistId: string, name: string): Promise<PlaylistGroupDto> {
    await this.require(ownerId, playlistId);
    const group = await this.deps.playlists.createGroup(playlistId, newEntityId(), name);
    if (!group) throw groupExists(name);
    return toGroupDto(group);
  }

  async renameGroup(ownerId: string, playlistId: string, groupId: string, name: string): Promise<void> {
    await this.require(ownerId, playlistId);
    const result = await this.deps.playlists.renameGroup(playlistId, groupId, name);
    if (result === 'duplicate') throw groupExists(name);
    if (result === 'not_found') throw AppError.notFound('Group');
  }

  async reorderGroups(ownerId: string, playlistId: string, groupIds: string[]): Promise<void> {
    await this.require(ownerId, playlistId);
    if (!(await this.deps.playlists.reorderGroups(playlistId, groupIds))) {
      throw AppError.validation('groupIds must list every group of the playlist exactly once.', [{ path: 'groupIds', message: 'must list every group exactly once' }]);
    }
  }

  async deleteGroup(ownerId: string, playlistId: string, groupId: string, deleteEntries: boolean): Promise<void> {
    await this.require(ownerId, playlistId);
    if (!(await this.deps.playlists.deleteGroup(playlistId, groupId, deleteEntries))) throw AppError.notFound('Group');
  }

  // --- export link --------------------------------------------------------------------------

  /**
   * Turns the link on, or replaces it (the old link stops working at once). The token is the
   * only credential of the public link, so it is 256 random bits, stored hashed for lookup and
   * sealed so the owner can see the link again later.
   */
  async enableExport(ownerId: string, playlistId: string, link: ExportLink): Promise<string> {
    if (this.deps.exportMode === 'off') throw new AppError('FORBIDDEN', 403, 'Playlist export links are disabled on this server.');
    const playlist = await this.require(ownerId, playlistId);
    const token = randomBytes(32).toString('base64url');
    await this.deps.playlists.setExportToken(playlistId, ownerId, { hash: hashExportToken(token), sealed: this.deps.cipher.encrypt(EXPORT_TOKEN_PURPOSE, token) });
    if (playlist.exportTokenHash) this.deps.onExportRevoked?.(playlist.exportTokenHash);
    this.deps.logger.info({ playlistId }, 'Playlist export link created');
    return link(token);
  }

  async disableExport(ownerId: string, playlistId: string): Promise<void> {
    const playlist = await this.require(ownerId, playlistId);
    await this.deps.playlists.setExportToken(playlistId, ownerId, null);
    if (playlist.exportTokenHash) this.deps.onExportRevoked?.(playlist.exportTokenHash);
    this.deps.logger.info({ playlistId }, 'Playlist export link revoked');
  }

  private async exportToken(playlist: PlaylistRecord): Promise<string | null> {
    if (!playlist.exportEnabled) return null;
    const sealed = await this.deps.playlists.getExportTokenSealed(playlist.id, playlist.ownerId);
    if (!sealed) return null;
    try {
      return this.deps.cipher.decrypt(EXPORT_TOKEN_PURPOSE, sealed);
    } catch (error) {
      // After a key change the link keeps working (it is looked up by hash) but can no longer be
      // shown; the owner can create a new one. Never fail the whole playlist over it.
      this.deps.logger.warn({ err: error, playlistId: playlist.id }, 'Could not read the playlist export link');
      return null;
    }
  }
}

const toGroupDto = (group: GroupRecord): PlaylistGroupDto => ({ id: group.id, name: group.name, position: group.position, entryCount: group.entryCount });
const groupExists = (name: string) => new AppError('GROUP_EXISTS', 409, `A group named "${name}" already exists in this playlist.`);
