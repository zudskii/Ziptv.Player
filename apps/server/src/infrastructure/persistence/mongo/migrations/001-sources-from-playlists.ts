import type { Types } from 'mongoose';

import { toStoredRevision } from '../../../../application/sources/catalog-storage.js';
import { computeStats } from '../../../../domain/catalog/model.js';
import type { ParsedChannel, ParsedPlaylist } from '../../../parsers/m3u/index.js';
import { buildCatalogFromPlaylist, isXtreamPlaylistUrl } from '../../../providers/m3u-catalog.js';
import { anyModel, insertInBatches } from '../mongo-utils.js';
import { EpisodeModel, LiveChannelModel, MovieModel, SeriesModel } from '../repositories/catalog.repository.js';
import { SourceModel } from '../repositories/source.repository.js';
import type { Migration } from './runner.js';

interface LegacyPlaylist {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  source: { type: 'file' | 'url'; fileName?: string; url?: string };
  revision: number;
  epgUrls?: string[];
  warnings?: { line: number; code: string; message: string }[];
  warningCount?: number;
  format?: string;
  encoding?: string;
  refreshedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

type LegacyChannel = Omit<ParsedChannel, 'key'> & { key: string };

/**
 * 2.x → 3.0: every playlist becomes a Source with the *same id*, its channels are re-read
 * into Live TV / Movies / Series (2.x put VOD entries into the channel list), stream URLs are
 * encrypted, and URL sources are queued for a fresh sync (EPG, catch-up, account info).
 *
 * Channel keys are unchanged, so 2.x favourites (playlistId → channelKey) still resolve.
 * The 2.x collections (`playlists`, `channels`) are left untouched; drop them once verified.
 */
export const sourcesFromPlaylists: Migration = {
  id: '001-sources-from-playlists',
  description: '2.x playlists → sources (Live TV / Movies / Series, encrypted locators)',
  async up({ db, secrets, logger, now }) {
    const playlists = db.collection<LegacyPlaylist>('playlists');
    const channels = db.collection<LegacyChannel & { playlistId: unknown; revision: number }>('channels');
    let migrated = 0;

    for await (const playlist of playlists.find({})) {
      if (await SourceModel.exists({ _id: playlist._id })) continue; // idempotent re-run

      const legacyChannels = await channels
        .find({ playlistId: playlist._id, revision: playlist.revision }, { projection: { _id: 0, playlistId: 0, revision: 0 } })
        .sort({ position: 1 })
        .toArray();

      const parsed: ParsedPlaylist = {
        format: (playlist.format as ParsedPlaylist['format']) ?? 'm3u',
        encoding: playlist.encoding ?? 'utf-8',
        title: null,
        epgUrls: playlist.epgUrls ?? [],
        headerAttributes: {},
        channels: legacyChannels.map((channel) => ({
          key: channel.key,
          position: channel.position,
          name: channel.name,
          groups: channel.groups ?? [],
          logo: channel.logo ?? null,
          tvgId: channel.tvgId ?? null,
          tvgName: channel.tvgName ?? null,
          url: channel.url,
          headers: channel.headers ?? {},
          kind: channel.kind ?? 'unknown',
          unplayableReason: channel.unplayableReason ?? null,
          duration: channel.duration ?? -1,
          attributes: channel.attributes ?? {},
        })),
        warnings: (playlist.warnings ?? []) as ParsedPlaylist['warnings'],
        warningCount: playlist.warningCount ?? 0,
        truncated: false,
      };
      const build = buildCatalogFromPlaylist(parsed);
      const isUrl = playlist.source.type === 'url' && !!playlist.source.url;
      const url = isUrl ? safeUrl(playlist.source.url!) : null;

      const revision = 1;
      const data = toStoredRevision(build, secrets);
      const base = { sourceId: playlist._id, revision };
      await Promise.all([LiveChannelModel, MovieModel, SeriesModel, EpisodeModel].map((model) => anyModel(model).deleteMany(base)));
      await insertInBatches(LiveChannelModel, data.live.map((item) => ({ ...base, ...item })));
      await insertInBatches(MovieModel, data.movies.map((item) => ({ ...base, ...item })));
      await insertInBatches(SeriesModel, data.series.map((item) => ({ ...base, ...item })));
      await insertInBatches(EpisodeModel, data.episodes.map((item) => ({ ...base, ...item })));

      await SourceModel.collection.insertOne({
        _id: playlist._id,
        ownerId: playlist.ownerId,
        name: (playlist.name || 'My playlist').slice(0, 80),
        type: url ? 'm3u_url' : 'm3u_file',
        origin: url ? { kind: 'url', host: url.host } : { kind: 'file', fileName: playlist.source.fileName ?? 'playlist.m3u' },
        credential: url ? secrets.sealCredential({ type: 'm3u_url', url: url.href }) : null,
        revision,
        epgVersion: 0,
        stats: computeStats(build),
        sync: {
          // URL sources sync right after the upgrade; files keep what was imported.
          status: url ? 'queued' : 'idle',
          stage: null,
          autoSync: Boolean(url),
          intervalHours: 6,
          lastAttemptAt: playlist.refreshedAt ?? null,
          lastSuccessAt: playlist.refreshedAt ?? null,
          nextSyncAt: url ? now : null,
          error: null,
          consecutiveFailures: 0,
          rerunRequested: false,
        },
        lease: { owner: null, until: null },
        health: { state: 'unknown', checkedAt: null, latencyMs: null, unstableStreams: 0, offlineStreams: 0, message: null },
        account: null,
        epgUrls: build.epgUrls.map((epgUrl) => secrets.sealGuideUrl(epgUrl)),
        warnings: build.warnings,
        warningCount: build.warningCount,
        format: build.format,
        encoding: build.encoding,
        xtreamCandidate: url ? isXtreamPlaylistUrl(url) : false,
        legacyPlaylist: true,
        createdAt: playlist.createdAt ?? now,
        updatedAt: now,
      });
      migrated++;
    }
    logger.info({ migrated }, '2.x playlists migrated to sources');
  },
};

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
