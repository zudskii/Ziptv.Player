import type { StaffPermission } from '@ziptv/contracts';
import { describe, expect, it } from 'vitest';

import { NAV, visibleNav } from './nav';

describe('console navigation', () => {
  it('lists only the sections the role grants', () => {
    const viewOnly = new Set<StaffPermission>(['system:read', 'catalog:read']);
    expect(visibleNav((p) => viewOnly.has(p)).map((item) => item.label)).toEqual(['Overview']);
    expect(visibleNav(() => true)).toHaveLength(NAV.length);
    expect(visibleNav(() => false)).toEqual([]);
  });
});
