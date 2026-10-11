import type { ChannelDto } from '@ziptv/contracts';

import { matchesQuery, normalizeForSearch } from '../../lib/search';

/** Channel plus precomputed search text (computed once per channel list, not per keystroke). */
export interface BrowsableChannel extends ChannelDto {
  searchText: string;
}

/** Serialized filter value (fits in a <select> and in URL/state): all | fav | recent | none | g:<label>. */
export type GroupFilterValue = 'all' | 'fav' | 'recent' | 'none' | `g:${string}`;

export interface GroupOption {
  value: GroupFilterValue;
  label: string;
  count: number;
}

export function toBrowsable(channels: ChannelDto[]): BrowsableChannel[] {
  return channels.map((channel) => ({
    ...channel,
    searchText: normalizeForSearch(`${channel.name} ${channel.tvgId ?? ''}`),
  }));
}

/**
 * Filter options in playlist order (providers order groups deliberately — never re-sort),
 * with counts. A channel with several groups counts in each of them.
 */
export function buildGroupOptions(channels: ChannelDto[], favoriteCount: number, recentCount: number): GroupOption[] {
  const counts = new Map<string, number>();
  let ungrouped = 0;
  for (const channel of channels) {
    if (channel.groups.length === 0) ungrouped++;
    for (const group of channel.groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const options: GroupOption[] = [{ value: 'all', label: 'All channels', count: channels.length }];
  if (favoriteCount > 0) options.push({ value: 'fav', label: 'Favorites', count: favoriteCount });
  if (recentCount > 0) options.push({ value: 'recent', label: 'Recently watched', count: recentCount });
  for (const [label, count] of counts) options.push({ value: `g:${label}`, label, count });
  if (ungrouped > 0 && counts.size > 0) options.push({ value: 'none', label: 'Uncategorized', count: ungrouped });
  return options;
}

export interface ChannelQuery {
  group: GroupFilterValue;
  search: string;
  favorites: ReadonlySet<string>;
  /** Most recent first. */
  recents: readonly string[];
}

/** The visible list for the current filter + search. Also drives next/previous channel. */
export function selectChannels(channels: BrowsableChannel[], query: ChannelQuery): BrowsableChannel[] {
  const search = normalizeForSearch(query.search);
  const matches = (channel: BrowsableChannel) => matchesQuery(channel.searchText, search);

  if (query.group === 'recent') {
    const byKey = new Map(channels.map((channel) => [channel.key, channel]));
    return query.recents.map((key) => byKey.get(key)).filter((channel): channel is BrowsableChannel => !!channel && matches(channel));
  }

  return channels.filter((channel) => {
    if (!matches(channel)) return false;
    switch (query.group) {
      case 'all':
        return true;
      case 'fav':
        return query.favorites.has(channel.key);
      case 'none':
        return channel.groups.length === 0;
      default:
        return channel.groups.includes(query.group.slice(2));
    }
  });
}

/** Neighbour in the visible list, wrapping around (TV-remote style channel up/down). */
export function neighbourChannel<T extends { key: string }>(list: readonly T[], currentKey: string | undefined, step: 1 | -1): T | undefined {
  if (list.length === 0) return undefined;
  const index = currentKey ? list.findIndex((channel) => channel.key === currentKey) : -1;
  if (index === -1) return step === 1 ? list[0] : list[list.length - 1];
  return list[(index + step + list.length) % list.length];
}
