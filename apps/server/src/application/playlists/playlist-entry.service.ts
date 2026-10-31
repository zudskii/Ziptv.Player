import type {
  AddEntriesResultDto,
  AddFromSourceRequest,
  PlaylistEntryDto,
  PlaylistEntryPageDto,
  RelinkResultDto,
  RenumberResultDto,
  TransferEntriesRequest,
  TransferEntriesResultDto,
  UpdateEntryRequest,
} from '@ziptv/contracts';

import { isEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { LiveChannelSummary } from '../ports/catalog-repository.js';
import type { Logger } from '../ports/logger.js';
import type { EntryFilter, EntryRecord, GroupTarget, NewEntry, PlaylistEntryRepository, TransferResult } from '../ports/playlist-repository.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import type { SourceRevisionListener } from '../sources/hooks.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import type { PlaylistService } from './playlist.service.js';

/** Highest channel number the database accepts (and players display sensibly). */
const MAX_NUMBER = 99_999;

/** What is in a playlist: adding channels from sources, editing, moving, removing, copying between playlists. */
export class PlaylistEntryService {
  constructor(
    private readonly deps: {
      playlists: PlaylistService;
      entries: PlaylistEntryRepository;
      sources: SourceRepository;
      /** Channels of a source's current revision (cached). */
      liveChannels: { summaries(source: SourceRecord): Promise<LiveChannelSummary[]> };
      limits: { maxEntriesPerPlaylist: number };
      logger: Logger;
      artwork?: ArtworkUrls;
    },
  ) {}

  private toDto = (entry: EntryRecord): PlaylistEntryDto => toDto(entry, this.deps.artwork ?? directArtwork);

  async list(
    ownerId: string,
    playlistId: string,
    query: { groupId?: string | undefined; ungrouped?: boolean | undefined; search?: string | undefined; missingOnly?: boolean | undefined; offset: number; limit: number },
  ): Promise<PlaylistEntryPageDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const filter: EntryFilter = {
      ...(query.ungrouped ? { group: 'ungrouped' as const } : query.groupId ? { group: { id: query.groupId } } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.missingOnly ? { missingOnly: true } : {}),
    };
    const page = await this.deps.entries.list(playlistId, filter, { offset: query.offset, limit: query.limit });
    return { items: page.items.map(this.toDto), total: page.total, offset: query.offset, limit: query.limit };
  }

  /**
   * Adds channels of one of the user's sources. Channels already in the playlist are skipped,
   * so repeating "add all" is how new channels of a source are picked up.
   */
  async addFromSource(ownerId: string, playlistId: string, request: AddFromSourceRequest): Promise<AddEntriesResultDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const source = isEntityId(request.sourceId) ? await this.deps.sources.findOwned(request.sourceId, ownerId) : null;
    if (!source) throw AppError.notFound('Source');
    if (source.revision === 0) throw new AppError('CONFLICT', 409, 'This source has not been loaded yet. Wait for its first sync to finish.');

    const channels = select(await this.deps.liveChannels.summaries(source), request.select);
    if (channels.length === 0) return { added: 0, skipped: 0 };

    const placement = request.placement;
    const group = (channel: LiveChannelSummary): GroupTarget =>
      placement.type === 'group' ? { id: placement.groupId } : placement.type === 'sourceGroups' ? (channel.groups[0] ? { name: channel.groups[0] } : null) : null;
    const entries: NewEntry[] = channels.map((channel) => ({
      sourceId: source.id,
      sourceKey: channel.key,
      originNameKey: channel.nameKey,
      name: channel.name,
      logo: channel.logo,
      tvgId: channel.tvgId,
      group: group(channel),
    }));

    const result = await this.deps.entries.addEntries(playlistId, entries, { maxEntries: this.deps.limits.maxEntriesPerPlaylist });
    if (result.status === 'full') throw playlistFull(this.deps.limits.maxEntriesPerPlaylist);
    if (result.status === 'group_not_found') throw AppError.notFound('Group');
    this.deps.logger.info({ playlistId, sourceId: source.id, added: result.added }, 'Channels added to playlist');
    return { added: result.added, skipped: result.skipped };
  }

  async update(ownerId: string, playlistId: string, entryId: string, patch: UpdateEntryRequest): Promise<PlaylistEntryDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const entry = await this.deps.entries.update(playlistId, entryId, patch);
    if (!entry) throw AppError.notFound('Entry');
    return this.toDto(entry);
  }

  async move(ownerId: string, playlistId: string, request: { entryIds: string[]; groupId: string | null; beforeEntryId?: string | null | undefined }): Promise<{ moved: number }> {
    await this.deps.playlists.require(ownerId, playlistId);
    const result = await this.deps.entries.move(playlistId, request.entryIds, { groupId: request.groupId, beforeEntryId: request.beforeEntryId ?? null });
    if (result === 'group_not_found') throw AppError.notFound('Group');
    return result;
  }

  async remove(ownerId: string, playlistId: string, entryIds: string[]): Promise<{ removed: number }> {
    await this.deps.playlists.require(ownerId, playlistId);
    return { removed: await this.deps.entries.remove(playlistId, entryIds) };
  }

  /** Numbers every entry in the order the playlist is displayed and exported. */
  async renumber(ownerId: string, playlistId: string, numbering: { start: number; step: number }): Promise<RenumberResultDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const { total } = await this.deps.entries.stats(playlistId);
    const last = numbering.start + Math.max(0, total - 1) * numbering.step;
    if (last > MAX_NUMBER) {
      throw AppError.validation(`Numbering ${total} channels from ${numbering.start} by ${numbering.step} would reach ${last}; the highest number is ${MAX_NUMBER}.`, [{ path: 'step', message: 'too large' }]);
    }
    return { renumbered: await this.deps.entries.renumber(playlistId, numbering) };
  }

  /** Copies or moves entries into another playlist of the same user. */
  async transfer(ownerId: string, playlistId: string, request: TransferEntriesRequest): Promise<TransferEntriesResultDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    await this.deps.playlists.require(ownerId, request.toPlaylistId);
    if (request.toPlaylistId === playlistId) throw AppError.validation('Choose a different playlist as the target.', [{ path: 'toPlaylistId', message: 'must differ from the source playlist' }]);
    return this.finish(
      await this.deps.entries.transfer({
        fromPlaylistId: playlistId,
        toPlaylistId: request.toPlaylistId,
        entryIds: request.entryIds,
        mode: request.mode,
        placement: request.group ? { by: 'group', groupId: request.group.groupId } : { by: 'name' },
        maxEntries: this.deps.limits.maxEntriesPerPlaylist,
      }),
    );
  }

  /**
   * Copies every group and entry of other playlists into this one. Each playlist is merged
   * atomically; if one does not fit, the ones before it stay merged.
   */
  async merge(ownerId: string, playlistId: string, sourcePlaylistIds: string[]): Promise<TransferEntriesResultDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const unique = [...new Set(sourcePlaylistIds)];
    if (unique.includes(playlistId)) throw AppError.validation('A playlist cannot be merged into itself.', [{ path: 'sourcePlaylistIds', message: 'contains the target playlist' }]);
    for (const id of unique) await this.deps.playlists.require(ownerId, id);

    let transferred = 0;
    let skipped = 0;
    for (const id of unique) {
      const result = await this.deps.entries.transfer({
        fromPlaylistId: id,
        toPlaylistId: playlistId,
        entryIds: 'all',
        mode: 'copy',
        placement: { by: 'name' },
        maxEntries: this.deps.limits.maxEntriesPerPlaylist,
      });
      const done = this.finish(result);
      transferred += done.transferred;
      skipped += done.skipped;
    }
    return { transferred, skipped };
  }

  /** Re-attaches entries whose channel the provider re-grouped (their catalog key changed). */
  async relink(ownerId: string, playlistId: string): Promise<RelinkResultDto> {
    await this.deps.playlists.require(ownerId, playlistId);
    const relinked = await this.deps.entries.relink({ playlistId });
    return { relinked, stillMissing: (await this.deps.entries.stats(playlistId)).missing };
  }

  private finish(result: TransferResult): TransferEntriesResultDto {
    if (result.status === 'full') throw playlistFull(this.deps.limits.maxEntriesPerPlaylist);
    if (result.status === 'group_not_found') throw AppError.notFound('Group');
    return { transferred: result.transferred, skipped: result.skipped };
  }
}

/** After every sync: entries the provider renamed away from their key find their channel again. */
export class PlaylistRelinker implements SourceRevisionListener {
  constructor(
    private readonly entries: PlaylistEntryRepository,
    private readonly logger: Logger,
  ) {}

  async onRevisionCommitted(source: SourceRecord): Promise<void> {
    const relinked = await this.entries.relink({ sourceId: source.id });
    if (relinked > 0) this.logger.info({ sourceId: source.id, relinked }, 'Playlist entries re-attached after sync');
  }
}

function select(channels: LiveChannelSummary[], selection: AddFromSourceRequest['select']): LiveChannelSummary[] {
  switch (selection.type) {
    case 'all':
      return channels;
    case 'keys': {
      const keys = new Set(selection.keys);
      return channels.filter((channel) => keys.has(channel.key));
    }
    case 'groups': {
      const groups = new Set(selection.groups.map((group) => group.toLowerCase()));
      return channels.filter((channel) => channel.groups.some((group) => groups.has(group.toLowerCase())));
    }
  }
}

const playlistFull = (max: number) => new AppError('PLAYLIST_FULL', 409, `A playlist can hold up to ${max} channels.`);

const toDto = (entry: EntryRecord, artwork: ArtworkUrls): PlaylistEntryDto => ({
  id: entry.id,
  groupId: entry.groupId,
  position: entry.position,
  number: entry.number,
  name: entry.name,
  logo: artwork.url(entry.logo),
  tvgId: entry.tvgId,
  sourceId: entry.sourceId,
  sourceName: entry.sourceName,
  sourceKey: entry.sourceKey,
  status: entry.status,
});
