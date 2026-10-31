import type { AddPlacement, AddSelection, ChannelDto } from '@ziptv/contracts';

/** What "Add channels" lets the person pick: everything, whole source groups, or single channels. */
export type AddMode = 'all' | 'groups' | 'channels';

export interface AddPicks {
  /** Source group labels. */
  groups: ReadonlySet<string>;
  /** Channel keys. */
  keys: ReadonlySet<string>;
}

/** One request carries this many channel keys at most (it also has to fit the body size limit). */
export const MAX_PICKED_CHANNELS = 10_000;

type ChannelLike = Pick<ChannelDto, 'key' | 'groups'>;

/** Group names match case-insensitively on the server, so they are counted the same way here. */
const lower = (labels: Iterable<string>) => new Set([...labels].map((label) => label.toLowerCase()));

/** How many channels the current choice adds (before skipping those already in the playlist). */
export function countSelected(channels: readonly ChannelLike[], mode: AddMode, picks: AddPicks): number {
  if (mode === 'all') return channels.length;
  if (mode === 'channels') return picks.keys.size;
  const wanted = lower(picks.groups);
  return channels.filter((channel) => channel.groups.some((group) => wanted.has(group.toLowerCase()))).length;
}

/** Why the choice cannot be sent, or null. */
export function selectionProblem(mode: AddMode, picks: AddPicks, channelCount: number): string | null {
  if (channelCount === 0) return 'This source has no channels.';
  if (mode === 'groups' && picks.groups.size === 0) return 'Pick at least one group.';
  if (mode === 'channels' && picks.keys.size === 0) return 'Pick at least one channel.';
  if (mode === 'channels' && picks.keys.size > MAX_PICKED_CHANNELS) return `Pick at most ${MAX_PICKED_CHANNELS.toLocaleString('en-US')} channels at a time, or add whole groups instead.`;
  return null;
}

export function buildSelection(mode: AddMode, picks: AddPicks): AddSelection {
  if (mode === 'groups') return { type: 'groups', groups: [...picks.groups] };
  if (mode === 'channels') return { type: 'keys', keys: [...picks.keys] };
  return { type: 'all' };
}

/** `groupId` null = no group. Ignored for "keep the source's groups". */
export function buildPlacement(keepSourceGroups: boolean, groupId: string | null): AddPlacement {
  if (keepSourceGroups) return { type: 'sourceGroups' };
  return groupId ? { type: 'group', groupId } : { type: 'ungrouped' };
}

/** The existing group with this name, ignoring case (a "new" group that already exists is reused). */
export function findGroupByName<T extends { name: string }>(groups: readonly T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return groups.find((group) => group.name.toLowerCase() === wanted);
}
