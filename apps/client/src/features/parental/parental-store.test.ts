import { beforeEach, describe, expect, it } from 'vitest';

import { archiveRange, paths } from '../../lib/routes';
import { unlockTokenFor, useParentalStore } from './parental-store';

describe('parental unlocks on this device', () => {
  beforeEach(() => useParentalStore.getState().clear());

  it('are per profile and stop being sent just before they expire', () => {
    const now = 1_000_000;
    useParentalStore.getState().setUnlock('default', { token: 'pu1.a', expiresAt: now + 60_000 });
    useParentalStore.getState().setUnlock('p2', { token: 'pu1.b', expiresAt: now + 4_000 });
    expect(unlockTokenFor(null, now)).toBe('pu1.a');
    expect(unlockTokenFor('p2', now)).toBeNull(); // too close to expiry to rely on
    expect(unlockTokenFor('p3', now)).toBeNull();
    useParentalStore.getState().clear();
    expect(unlockTokenFor(null, now)).toBeNull();
  });
});

describe('archive links', () => {
  it('carry the programme in the query and round-trip', () => {
    const programme = { start: '2026-10-28T18:00:00.000Z', end: '2026-10-28T19:00:00.000Z' };
    const link = paths.archive('src', 'key1', programme);
    expect(link).toBe('/live/src/key1?at=2026-10-28T18%3A00%3A00.000Z&until=2026-10-28T19%3A00%3A00.000Z');
    expect(archiveRange(new URL(link, 'http://x').searchParams)).toEqual(programme);
    expect(paths.operatorArchive('c1', programme)).toMatch(/^\/channels\/c1\?at=/);
    expect(archiveRange(new URLSearchParams('at=nonsense&until=2026-10-28T19:00:00Z'))).toBeNull();
    expect(archiveRange(new URLSearchParams(''))).toBeNull();
  });
});
