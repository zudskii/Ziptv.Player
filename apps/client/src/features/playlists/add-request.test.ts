import { describe, expect, it } from 'vitest';

import { buildPlacement, buildSelection, countSelected, findGroupByName, MAX_PICKED_CHANNELS, selectionProblem } from './add-request';

const channels = [
  { key: 'a', groups: ['News'] },
  { key: 'b', groups: ['News', 'HD'] },
  { key: 'c', groups: ['Sport'] },
  { key: 'd', groups: [] },
];
const none = { groups: new Set<string>(), keys: new Set<string>() };

describe('what gets added', () => {
  it('counts every channel for "all", picked keys for "channels", and each channel once for "groups"', () => {
    expect(countSelected(channels, 'all', none)).toBe(4);
    expect(countSelected(channels, 'channels', { ...none, keys: new Set(['a', 'c']) })).toBe(2);
    // "b" is in both News and HD but is one channel.
    expect(countSelected(channels, 'groups', { ...none, groups: new Set(['News', 'HD']) })).toBe(2);
    expect(countSelected(channels, 'groups', { ...none, groups: new Set(['news']) })).toBe(2); // case-insensitive, like the server
    expect(countSelected(channels, 'groups', none)).toBe(0);
  });

  it('asks for a choice before sending, and refuses lists the server would refuse', () => {
    expect(selectionProblem('all', none, 4)).toBeNull();
    expect(selectionProblem('all', none, 0)).toMatch(/no channels/);
    expect(selectionProblem('groups', none, 4)).toMatch(/group/);
    expect(selectionProblem('channels', none, 4)).toMatch(/channel/);
    expect(selectionProblem('groups', { ...none, groups: new Set(['News']) }, 4)).toBeNull();
    const tooMany = new Set(Array.from({ length: MAX_PICKED_CHANNELS + 1 }, (_, i) => `k${i}`));
    expect(selectionProblem('channels', { ...none, keys: tooMany }, 20_000)).toMatch(/10,000/);
  });

  it('builds the request bodies the server expects', () => {
    expect(buildSelection('all', none)).toEqual({ type: 'all' });
    expect(buildSelection('groups', { ...none, groups: new Set(['News', 'Sport']) })).toEqual({ type: 'groups', groups: ['News', 'Sport'] });
    expect(buildSelection('channels', { ...none, keys: new Set(['a']) })).toEqual({ type: 'keys', keys: ['a'] });
    expect(buildPlacement(true, 'ignored')).toEqual({ type: 'sourceGroups' });
    expect(buildPlacement(false, 'g1')).toEqual({ type: 'group', groupId: 'g1' });
    expect(buildPlacement(false, null)).toEqual({ type: 'ungrouped' });
  });

  it('reuses a group that already exists under the same name', () => {
    const groups = [{ id: '1', name: 'News' }, { id: '2', name: 'Sport' }];
    expect(findGroupByName(groups, ' news ')?.id).toBe('1');
    expect(findGroupByName(groups, 'Movies')).toBeUndefined();
  });
});
