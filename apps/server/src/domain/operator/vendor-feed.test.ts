import { describe, expect, it } from 'vitest';

import { qualityCapFor, type RightsGrant } from './rights.js';
import { beyondFeed, checkRight, expandRights, freshnessProblem, type FeedRight, type GrantTerms } from './vendor-feed.js';

const now = new Date('2026-11-05T12:00:00Z');
const right = (patch: Partial<FeedRight> = {}): FeedRight => ({ territories: ['GE'], devices: ['web', 'tv'], models: ['subscription'], start: new Date('2026-01-01T00:00:00Z'), end: null, catchupDays: 3, maxQuality: null, ...patch });

describe('vendor feed rights', () => {
  it('accepts sound rights and names what is wrong with the others', () => {
    expect(checkRight(right())).toBeNull();
    expect(checkRight(right({ territories: ['*'] }))).toBeNull();
    expect(checkRight(right({ territories: [] }))).toMatch(/empty/);
    expect(checkRight(right({ territories: ['Georgia'] }))).toMatch(/Georgia/);
    expect(checkRight(right({ devices: ['toaster' as never] }))).toMatch(/devices/);
    expect(checkRight(right({ models: [] }))).toMatch(/models/);
    expect(checkRight(right({ end: new Date('2025-01-01T00:00:00Z') }))).toMatch(/end/);
    expect(checkRight(right({ catchupDays: 31 }))).toMatch(/catchupDays/);
  });

  it('becomes one grant per territory', () => {
    expect(expandRights([right({ territories: ['GE', 'AM', 'GE'] })]).map((entry) => entry.territory)).toEqual(['GE', 'AM']);
  });

  it('refuses feeds from the future, older than a week, or older than the one applied (no rollback)', () => {
    expect(freshnessProblem(new Date(now.getTime() - 60_000), null, now)).toBeNull();
    expect(freshnessProblem(new Date(now.getTime() + 3_600_000), null, now)).toMatch(/future/);
    expect(freshnessProblem(new Date(now.getTime() - 8 * 86_400_000), null, now)).toMatch(/7 days/);
    expect(freshnessProblem(new Date(now.getTime() - 120_000), new Date(now.getTime() - 60_000), now)).toMatch(/already applied/);
  });

  it('flags staff grants wider than the feed licenses', () => {
    const feed: GrantTerms[] = [{ territory: 'GE', deviceClasses: ['web', 'tv'], businessModels: ['subscription'], startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2027-01-01T00:00:00Z'), catchupDays: 3 }];
    const grant = (patch: Partial<GrantTerms> = {}): GrantTerms => ({ territory: 'GE', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date('2026-02-01T00:00:00Z'), endAt: new Date('2026-12-01T00:00:00Z'), catchupDays: 0, ...patch });
    expect(beyondFeed(grant(), feed)).toBeNull();
    expect(beyondFeed(grant({ territory: 'AM' }), feed)).toMatch(/territory AM/);
    expect(beyondFeed(grant({ deviceClasses: ['web', 'mobile'] }), feed)).toMatch(/devices/);
    expect(beyondFeed(grant({ businessModels: ['fast'] }), feed)).toMatch(/models/);
    expect(beyondFeed(grant({ endAt: null }), feed)).toMatch(/window/);
    expect(beyondFeed(grant({ catchupDays: 7 }), feed)).toMatch(/catch-up/);
    expect(beyondFeed(grant(), [{ ...feed[0]!, territory: '*' }])).toBeNull();
  });
});

describe('quality limit', () => {
  const grant = (patch: Partial<RightsGrant>): RightsGrant => ({ id: 'g', channelId: 'c', territory: 'GE', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date('2026-01-01T00:00:00Z'), endAt: null, status: 'active', catchupDays: 0, maxQuality: null, ...patch });
  const query = { country: 'GE', device: 'web' as const, at: now };

  it('is the most generous cap among the covering grants; an unlimited grant lifts it', () => {
    expect(qualityCapFor([grant({ maxQuality: 'hd' })], query)).toBe('hd');
    expect(qualityCapFor([grant({ maxQuality: 'hd' }), grant({ maxQuality: 'fhd' })], query)).toBe('fhd');
    expect(qualityCapFor([grant({ maxQuality: 'sd' }), grant({ maxQuality: null })], query)).toBeNull();
    // A grant that does not cover the viewer does not count.
    expect(qualityCapFor([grant({ maxQuality: 'sd' }), grant({ maxQuality: null, territory: 'AM' })], query)).toBe('sd');
  });
});
