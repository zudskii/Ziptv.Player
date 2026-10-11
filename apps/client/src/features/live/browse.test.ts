import type { ChannelDto } from '@ziptv/contracts';
import { describe, expect, it } from 'vitest';

import { buildGroupOptions, neighbourChannel, selectChannels, toBrowsable } from './browse';

const channel = (key: string, name: string, groups: string[]): ChannelDto => ({
  key,
  name,
  groups,
  logo: null,
  tvgId: null,
  kind: 'hls',
  unplayableReason: null,
  catchupDays: null,
  hasEpg: false,
  locked: false,
});

const channels = [
  channel('a', 'Rustavi 2', ['ქართული']),
  channel('b', 'Télé Sport HD', ['Sports', 'HD']),
  channel('c', 'Первый канал', ['Кино']),
  channel('d', 'No group', []),
  channel('e', 'Sport 2', ['Sports']),
];

describe('buildGroupOptions', () => {
  it('keeps playlist order, counts multi-group channels in each group, adds virtual groups', () => {
    expect(buildGroupOptions(channels, 1, 2)).toEqual([
      { value: 'all', label: 'All channels', count: 5 },
      { value: 'fav', label: 'Favorites', count: 1 },
      { value: 'recent', label: 'Recently watched', count: 2 },
      { value: 'g:ქართული', label: 'ქართული', count: 1 },
      { value: 'g:Sports', label: 'Sports', count: 2 },
      { value: 'g:HD', label: 'HD', count: 1 },
      { value: 'g:Кино', label: 'Кино', count: 1 },
      { value: 'none', label: 'Uncategorized', count: 1 },
    ]);
  });
});

describe('selectChannels', () => {
  const browsable = toBrowsable(channels);
  const base = { favorites: new Set(['c']), recents: ['e', 'a', 'zzz'] };

  it('filters by group and accent/case-insensitive multi-term search', () => {
    expect(selectChannels(browsable, { ...base, group: 'g:Sports', search: '' }).map((c) => c.key)).toEqual(['b', 'e']);
    expect(selectChannels(browsable, { ...base, group: 'all', search: 'tele  hd' }).map((c) => c.key)).toEqual(['b']);
    expect(selectChannels(browsable, { ...base, group: 'all', search: 'первый' }).map((c) => c.key)).toEqual(['c']);
    expect(selectChannels(browsable, { ...base, group: 'none', search: '' }).map((c) => c.key)).toEqual(['d']);
  });

  it('shows favorites, and recents in recency order (skipping channels that no longer exist)', () => {
    expect(selectChannels(browsable, { ...base, group: 'fav', search: '' }).map((c) => c.key)).toEqual(['c']);
    expect(selectChannels(browsable, { ...base, group: 'recent', search: '' }).map((c) => c.key)).toEqual(['e', 'a']);
  });
});

describe('neighbourChannel', () => {
  it('wraps around in both directions', () => {
    expect(neighbourChannel(channels, 'e', 1)?.key).toBe('a');
    expect(neighbourChannel(channels, 'a', -1)?.key).toBe('e');
    expect(neighbourChannel(channels, 'missing', 1)?.key).toBe('a');
    expect(neighbourChannel([], 'a', 1)).toBeUndefined();
  });
});
