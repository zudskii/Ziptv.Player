import { describe, expect, it } from 'vitest';

import { isEntityId, newEntityId } from './ids.js';

describe('entity ids (UUIDv7)', () => {
  it('has the UUID shape with version 7 and the RFC variant', () => {
    const id = newEntityId();
    expect(isEntityId(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('is unique and sorts by creation time', () => {
    const early = newEntityId(1_700_000_000_000);
    const late = newEntityId(1_700_000_000_001);
    expect(early < late).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => newEntityId())).size).toBe(1000);
  });

  it('rejects anything that is not a UUID (including the old 24-hex ids)', () => {
    expect(isEntityId('507f1f77bcf86cd799439011')).toBe(false);
    expect(isEntityId('')).toBe(false);
    expect(isEntityId("0192f7d0-0000-7000-8000-000000000000'; DROP TABLE users;--")).toBe(false);
  });
});
