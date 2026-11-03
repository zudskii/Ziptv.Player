import { describe, expect, it } from 'vitest';

import { aliasKeys, isTerritory, slugify, validateLineup } from './catalog.js';
import { playableFeeds } from './feeds.js';
import { denialReason, findCoveringGrant, type RightsGrant } from './rights.js';

const at = new Date('2026-10-27T12:00:00Z');
const grant = (patch: Partial<RightsGrant> = {}): RightsGrant => ({
  id: 'g1',
  channelId: 'c1',
  territory: 'GE',
  deviceClasses: ['web', 'mobile'],
  businessModels: ['subscription'],
  startAt: new Date('2026-01-01T00:00:00Z'),
  endAt: new Date('2027-01-01T00:00:00Z'),
  status: 'active',
  ...patch,
});

describe('rights', () => {
  it('covers only the right territory, device, model and time window', () => {
    const query = { country: 'GE', device: 'web' as const, at };
    expect(findCoveringGrant([grant()], query)?.id).toBe('g1');
    expect(findCoveringGrant([grant()], { ...query, country: 'DE' })).toBeNull();
    expect(findCoveringGrant([grant()], { ...query, device: 'tv' })).toBeNull();
    expect(findCoveringGrant([grant()], { ...query, model: 'fast' })).toBeNull();
    expect(findCoveringGrant([grant({ endAt: at })], query)).toBeNull(); // end is exclusive
    expect(findCoveringGrant([grant({ startAt: new Date(at.getTime() + 1) })], query)).toBeNull();
    expect(findCoveringGrant([grant({ status: 'revoked' })], query)).toBeNull();
    expect(findCoveringGrant([grant({ territory: '*', endAt: null })], { ...query, country: null })?.id).toBe('g1');
    expect(findCoveringGrant([grant()], { ...query, country: null })).toBeNull();
  });

  it('explains denials', () => {
    const query = { country: 'DE', device: 'web' as const, at };
    expect(denialReason([grant()], query)).toBe('territory');
    expect(denialReason([grant({ territory: 'DE', deviceClasses: ['tv'] })], query)).toBe('device');
    expect(denialReason([grant({ status: 'revoked' })], query)).toBe('not_licensed');
    expect(denialReason([], query)).toBe('not_licensed');
  });
});

describe('feeds', () => {
  it('orders playable feeds by priority and skips paused providers, disabled or gone streams', () => {
    const base = { status: 'active' as const, providerStatus: 'active' as const, streamStatus: 'matched' as const, createdAt: at };
    const feeds = [
      { ...base, id: 'backup', priority: 20 },
      { ...base, id: 'primary', priority: 10 },
      { ...base, id: 'paused', priority: 1, providerStatus: 'paused' as const },
      { ...base, id: 'gone', priority: 2, streamStatus: 'gone' as const },
      { ...base, id: 'off', priority: 3, status: 'disabled' as const },
    ];
    expect(playableFeeds(feeds).map((feed) => feed.id)).toEqual(['primary', 'backup']);
  });
});

describe('catalog helpers', () => {
  it('builds dedup keys, slugs and validates lineups and territories', () => {
    expect(aliasKeys({ name: 'UK: BBC One HD', tvgId: ' BBC1.uk ' })).toEqual([
      { kind: 'tvg_id', key: 'bbc1.uk' },
      { kind: 'name', key: 'bbc one' },
    ]);
    expect(slugify('Rustavi 2 HD!')).toBe('rustavi-2-hd');
    expect(slugify('***')).toBe('channel');
    expect(validateLineup([{ channelId: 'a', number: 1 }, { channelId: 'b', number: 2 }])).toBeNull();
    expect(validateLineup([{ channelId: 'a', number: 1 }, { channelId: 'b', number: 1 }])).toMatch(/twice/);
    expect(validateLineup([{ channelId: 'a', number: 0 }])).toMatch(/positive/);
    expect(isTerritory('*')).toBe(true);
    expect(isTerritory('ge')).toBe(false);
  });
});
