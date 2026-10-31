import { describe, expect, it } from 'vitest';

import { AUDIT_GENESIS, auditHash, canonicalJson, verifyAuditChain, type AuditFields } from './audit.js';
import { can, PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES } from './rbac.js';
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from './totp.js';

describe('RBAC matrix', () => {
  it('every role grants only known permissions; super admin has all; view-only writes nothing', () => {
    for (const role of STAFF_ROLES) for (const permission of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(permission);
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual([...PERMISSIONS].sort());
    expect(ROLE_PERMISSIONS.VIEW_ONLY.some((permission) => /:(write|operate)$/.test(permission))).toBe(false);
  });

  it('only super admins manage staff', () => {
    for (const role of STAFF_ROLES) expect(can(role, 'staff:write')).toBe(role === 'SUPER_ADMIN');
    expect(can('SUPPORT_AGENT', 'users:write')).toBe(true);
    expect(can('FINANCE', 'catalog:write')).toBe(false);
  });
});

describe('TOTP (RFC 6238 vectors, 6 digits)', () => {
  // RFC secret "12345678901234567890" (ASCII) for HMAC-SHA1.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('base32 round-trips', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%i → %s', (seconds, code) => {
    expect(totpCode(secret, totpStep(seconds * 1000))).toBe(code);
  });

  it('accepts ±1 step of drift, refuses replays and malformed codes', () => {
    const now = 1_234_567_890_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step), now, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull(); // already used
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, step)).toBe(step + 1);
    expect(verifyTotp(secret, '12345', now, null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });
});

describe('audit chain', () => {
  const entry = (seq: number, prevHash: string, action: string): AuditFields & { hash: string } => {
    const fields: AuditFields = {
      seq,
      occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
      actorId: null,
      actorEmail: 'a@x',
      action,
      targetType: 'staff',
      targetId: 't',
      beforeHash: null,
      afterHash: null,
      details: { b: 1, a: [2, { d: 3, c: 4 }] },
      ip: null,
      prevHash,
    };
    return { ...fields, hash: auditHash(fields) };
  };

  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it('verifies an intact chain and pinpoints edits, deletions and re-ordering', () => {
    const one = entry(1, AUDIT_GENESIS, 'staff.created');
    const two = entry(2, one.hash, 'staff.updated');
    const three = entry(3, two.hash, 'staff.login');
    expect(verifyAuditChain([one, two, three])).toBeNull();
    expect(verifyAuditChain([one, { ...two, action: 'staff.login' }, three])).toEqual({ seq: 2, reason: 'entry content was changed' });
    expect(verifyAuditChain([one, three])).toEqual({ seq: 3, reason: 'previous hash does not match' });
    expect(verifyAuditChain([two, one, three])?.seq).toBe(2);
  });
});
