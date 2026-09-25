import type { ChannelListDto, PlaylistDto } from '@ziptv/contracts';

import type { Logger } from '../../infrastructure/logger.js';
import { AppError } from '../../shared/errors.js';
import { parsePlaylistBytes, PlaylistFormatError, type ParsedPlaylist } from '../m3u/index.js';
import type { ChannelRecord, ChannelRepository } from './channel.repository.js';
import type { PlaylistSourceFetcher } from './playlist-source.js';
import { toChannelDto, toPlaylistDto } from './playlist.mapper.js';
import type { PlaylistRecord, PlaylistRepository, PlaylistSnapshot, PlaylistSource } from './playlist.repository.js';

export interface PlaylistLimits {
  maxChannelsPerPlaylist: number;
  maxPlaylistsPerUser: number;
}

interface PlaylistServiceDeps {
  playlists: PlaylistRepository;
  channels: ChannelRepository;
  fetcher: PlaylistSourceFetcher;
  limits: PlaylistLimits;
  logger: Logger;
  now?: () => Date;
}

/**
 * Use cases for playlists. Owns the invariants:
 * - a playlist is only visible once all its channels are stored;
 * - a refresh swaps channel sets atomically for readers (revision + compare-and-set);
 * - every read/write is scoped to the owner.
 */
export class PlaylistService {
  private readonly playlists: PlaylistRepository;
  private readonly channels: ChannelRepository;
  private readonly fetcher: PlaylistSourceFetcher;
  private readonly limits: PlaylistLimits;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(deps: PlaylistServiceDeps) {
    this.playlists = deps.playlists;
    this.channels = deps.channels;
    this.fetcher = deps.fetcher;
    this.limits = deps.limits;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  async list(ownerId: string): Promise<PlaylistDto[]> {
    return (await this.playlists.listByOwner(ownerId)).map(toPlaylistDto);
  }

  async get(ownerId: string, playlistId: string): Promise<PlaylistDto> {
    return toPlaylistDto(await this.requireOwned(ownerId, playlistId));
  }

  async createFromUpload(ownerId: string, input: { fileName: string; bytes: Buffer; name?: string | undefined }): Promise<PlaylistDto> {
    await this.assertCanCreate(ownerId);
    const parsed = this.parse(input.bytes);
    const name = input.name || stripExtension(input.fileName) || parsed.title || 'My playlist';
    return this.persistNew(ownerId, name, { type: 'file', fileName: input.fileName }, parsed);
  }

  async createFromUrl(ownerId: string, input: { url: URL; name?: string | undefined }): Promise<PlaylistDto> {
    await this.assertCanCreate(ownerId);
    const { bytes, finalUrl } = await this.fetcher.fetch(input.url);
    const parsed = this.parse(bytes, finalUrl);
    const name = input.name || parsed.title || input.url.hostname;
    return this.persistNew(ownerId, name, { type: 'url', url: input.url.href }, parsed);
  }

  /** Re-downloads a URL playlist (provider tokens rotate, channels get added/removed). */
  async refresh(ownerId: string, playlistId: string): Promise<PlaylistDto> {
    const playlist = await this.requireOwned(ownerId, playlistId);
    if (playlist.source.type !== 'url') {
      throw new AppError('PLAYLIST_NOT_REFRESHABLE', 409, 'Only playlists imported from a URL can be refreshed. Upload the file again instead.');
    }

    const sourceUrl = new URL(playlist.source.url);
    const { bytes, finalUrl } = await this.fetcher.fetch(sourceUrl);
    const parsed = this.parse(bytes, finalUrl);
    const nextRevision = playlist.revision + 1;

    await this.channels.deleteRevision(playlist.id, nextRevision); // leftovers of a crashed attempt
    await this.channels.insertRevision(playlist.id, nextRevision, parsed.channels);

    const updated = await this.playlists.replaceSnapshot(playlist.id, playlist.revision, this.snapshot(parsed, nextRevision));
    if (!updated) {
      await this.channels.deleteRevision(playlist.id, nextRevision);
      throw new AppError('CONFLICT', 409, 'The playlist was changed concurrently. Try again.');
    }

    await this.channels.deleteRevisionsExcept(playlist.id, nextRevision);
    this.logger.info({ playlistId: playlist.id, revision: nextRevision, channels: parsed.channels.length }, 'Playlist refreshed');
    return toPlaylistDto(updated);
  }

  async rename(ownerId: string, playlistId: string, name: string): Promise<PlaylistDto> {
    this.assertValidId(playlistId);
    const updated = await this.playlists.rename(playlistId, ownerId, name);
    if (!updated) throw AppError.notFound('Playlist');
    return toPlaylistDto(updated);
  }

  async remove(ownerId: string, playlistId: string): Promise<void> {
    this.assertValidId(playlistId);
    const deleted = await this.playlists.deleteOwned(playlistId, ownerId);
    if (!deleted) throw AppError.notFound('Playlist');
    await this.channels.deleteAll(playlistId);
  }

  async listChannels(ownerId: string, playlistId: string): Promise<ChannelListDto> {
    const playlist = await this.requireOwned(ownerId, playlistId);
    const channels = await this.channels.listSummaries(playlist.id, playlist.revision);
    return { playlistId: playlist.id, revision: playlist.revision, channels: channels.map(toChannelDto) };
  }

  /** Cheap check used for HTTP caching of the channel list. */
  async currentRevision(ownerId: string, playlistId: string): Promise<number> {
    return (await this.requireOwned(ownerId, playlistId)).revision;
  }

  async getChannel(ownerId: string, playlistId: string, channelKey: string): Promise<ChannelRecord> {
    const playlist = await this.requireOwned(ownerId, playlistId);
    const channel = await this.channels.findByKey(playlist.id, playlist.revision, channelKey);
    if (!channel) throw AppError.notFound('Channel');
    return channel;
  }

  /** Public (unauthenticated) lookup used only for logo proxying. */
  async findChannelLogo(playlistId: string, channelKey: string): Promise<string | null> {
    if (!this.playlists.isValidId(playlistId)) return null;
    const playlist = await this.playlists.findById(playlistId);
    if (!playlist) return null;
    const channel = await this.channels.findByKey(playlist.id, playlist.revision, channelKey);
    return channel?.logo ?? null;
  }

  // -------------------------------------------------------------------------

  private async persistNew(ownerId: string, name: string, source: PlaylistSource, parsed: ParsedPlaylist): Promise<PlaylistDto> {
    const id = this.playlists.newId();
    const revision = 1;
    try {
      await this.channels.insertRevision(id, revision, parsed.channels);
      const record = await this.playlists.create({ id, ownerId, name: name.slice(0, 120), source, snapshot: this.snapshot(parsed, revision) });
      this.logger.info({ playlistId: id, channels: parsed.channels.length, format: parsed.format }, 'Playlist imported');
      return toPlaylistDto(record);
    } catch (error) {
      await this.channels.deleteAll(id).catch(() => undefined);
      throw error;
    }
  }

  private parse(bytes: Buffer, baseUrl?: URL): ParsedPlaylist {
    let parsed: ParsedPlaylist;
    try {
      parsed = parsePlaylistBytes(bytes, { baseUrl, maxChannels: this.limits.maxChannelsPerPlaylist });
    } catch (error) {
      if (error instanceof PlaylistFormatError) throw new AppError('PLAYLIST_INVALID', 422, error.message, { reason: error.reason });
      throw error;
    }
    if (parsed.channels.length === 0) {
      throw new AppError('PLAYLIST_EMPTY', 422, 'No playable entries were found in this playlist.', {
        warnings: parsed.warnings.slice(0, 20),
      });
    }
    return parsed;
  }

  private snapshot(parsed: ParsedPlaylist, revision: number): PlaylistSnapshot {
    const groups = new Set<string>();
    let unplayable = 0;
    for (const channel of parsed.channels) {
      for (const group of channel.groups) groups.add(group);
      if (channel.unplayableReason) unplayable++;
    }
    return {
      revision,
      stats: { channels: parsed.channels.length, groups: groups.size, unplayable },
      epgUrls: parsed.epgUrls,
      warnings: parsed.warnings,
      warningCount: parsed.warningCount,
      format: parsed.format,
      encoding: parsed.encoding,
      refreshedAt: this.now(),
    };
  }

  private async assertCanCreate(ownerId: string): Promise<void> {
    if ((await this.playlists.countByOwner(ownerId)) >= this.limits.maxPlaylistsPerUser) {
      throw new AppError(
        'PLAYLIST_LIMIT_REACHED',
        409,
        `You can keep up to ${this.limits.maxPlaylistsPerUser} playlists. Delete one to add another.`,
      );
    }
  }

  private async requireOwned(ownerId: string, playlistId: string): Promise<PlaylistRecord> {
    this.assertValidId(playlistId);
    const playlist = await this.playlists.findOwned(playlistId, ownerId);
    if (!playlist) throw AppError.notFound('Playlist');
    return playlist;
  }

  private assertValidId(playlistId: string): void {
    if (!this.playlists.isValidId(playlistId)) throw AppError.notFound('Playlist');
  }
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.(m3u8?|pls|txt)$/i, '').trim();
}
