import { describe, expect, it } from 'vitest';

import { decisionProblem, isOpen, type ChangeRequestState } from './change-requests.js';
import { permissionsOf } from './rbac.js';

const enrolled = new Date('2026-01-01T00:00:00Z');
const requestedAt = new Date('2026-02-01T00:00:00Z');
const finance = (id: string, mfaEnrolledAt: Date | null = enrolled) => ({ id, permissions: permissionsOf('FINANCE'), mfaEnrolledAt });
const content = (id: string) => ({ id, permissions: permissionsOf('CONTENT_MANAGER'), mfaEnrolledAt: enrolled });
const pending: ChangeRequestState = { kind: 'package.update', mode: 'approval', status: 'pending', requestedBy: 'a', requestedAt };

describe('four-eyes decisions', () => {
  it('needs a second person with the same authority', () => {
    expect(decisionProblem(pending, 'approve', finance('a'))).toMatch(/second person/);
    expect(decisionProblem(pending, 'approve', finance('b'))).toBeNull();
    expect(decisionProblem(pending, 'approve', content('b'))).toMatch(/role cannot/);
    expect(decisionProblem(pending, 'reject', finance('a'))).toMatch(/second person/);
  });

  it('withdrawal is the requester’s alone, and only while pending', () => {
    expect(decisionProblem(pending, 'withdraw', finance('a'))).toBeNull();
    expect(decisionProblem(pending, 'withdraw', finance('b'))).toMatch(/Only the person/);
    expect(decisionProblem({ ...pending, status: 'applied' }, 'withdraw', finance('a'))).toMatch(/pending/);
  });

  it('emergency revocations are reviewed afterwards by someone else', () => {
    const revoked: ChangeRequestState = { kind: 'rights.revoke', mode: 'review', status: 'applied', requestedBy: 'a', requestedAt };
    expect(isOpen(revoked)).toBe(true);
    expect(decisionProblem(revoked, 'review', content('a'))).toMatch(/second person/);
    expect(decisionProblem(revoked, 'review', content('b'))).toBeNull();
    expect(decisionProblem(revoked, 'approve', content('b'))).toMatch(/no longer pending/);
    expect(isOpen({ ...revoked, status: 'reviewed' })).toBe(false);
    expect(decisionProblem({ ...pending, status: 'rejected' }, 'approve', finance('b'))).toMatch(/no longer pending/);
  });

  it('an account whose MFA was (re-)enrolled after the request cannot be the second person', () => {
    expect(decisionProblem(pending, 'approve', finance('b', new Date('2026-03-01T00:00:00Z')))).toMatch(/MFA was set up after/);
    expect(decisionProblem(pending, 'reject', finance('b', null))).toMatch(/MFA/);
    expect(decisionProblem(pending, 'withdraw', finance('a', new Date('2026-03-01T00:00:00Z')))).toBeNull();
  });
});
