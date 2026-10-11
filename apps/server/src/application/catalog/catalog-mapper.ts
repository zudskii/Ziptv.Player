import type { ChannelDto } from '@ziptv/contracts';

import type { LiveChannelSummary } from '../ports/catalog-repository.js';

export function toChannelDto(channel: LiveChannelSummary, locked: boolean): ChannelDto {
  return {
    key: channel.key,
    name: channel.name,
    groups: channel.groups,
    logo: channel.logo,
    tvgId: channel.tvgId,
    kind: channel.kind,
    unplayableReason: channel.unplayableReason,
    catchupDays: channel.catchup?.days ?? null,
    hasEpg: channel.epg !== null,
    locked,
  };
}
