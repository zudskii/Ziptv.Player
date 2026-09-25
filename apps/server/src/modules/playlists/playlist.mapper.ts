import type { ChannelDto, PlaylistDto } from '@ziptv/contracts';

import type { ChannelSummary } from './channel.repository.js';
import type { PlaylistRecord } from './playlist.repository.js';

export function toPlaylistDto(record: PlaylistRecord): PlaylistDto {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    revision: record.revision,
    stats: record.stats,
    epgUrls: record.epgUrls,
    warnings: record.warnings,
    warningCount: record.warningCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    refreshedAt: record.refreshedAt.toISOString(),
  };
}

export function toChannelDto(channel: ChannelSummary): ChannelDto {
  return {
    key: channel.key,
    name: channel.name,
    groups: channel.groups ?? [],
    logo: channel.logo ?? null,
    tvgId: channel.tvgId ?? null,
    kind: channel.kind,
    unplayableReason: channel.unplayableReason ?? null,
  };
}
