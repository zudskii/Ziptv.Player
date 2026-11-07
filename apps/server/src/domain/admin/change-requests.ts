import type { Permission } from './rbac.js';

/**
 * Four-eyes control (pure). Changes that move money or licences are made by two people:
 *
 *   approval  the change waits; a *different* staff member with the same authority approves it,
 *             and only then is it applied (prices, packages, new rights grants);
 *   review    the change applies at once — it must not wait (a licence ended, a rights grant is
 *             revoked) — and a different staff member reviews it afterwards.
 *
 * The requester can withdraw their own pending request but can never approve, reject or review
 * it. An approval checks that the target has not changed since the request (stale requests fail).
 */

export const CHANGE_KINDS = ['package.create', 'package.update', 'rights.grant', 'rights.revoke', 'promo.create'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ChangeMode = 'approval' | 'review';
export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'failed' | 'reviewed';

export interface ChangePolicy {
  mode: ChangeMode;
  /** Needed to request it and to decide on it. */
  write: Permission;
  /** Needed to see it. */
  read: Permission;
}

export const CHANGE_POLICY: Readonly<Record<ChangeKind, ChangePolicy>> = {
  'package.create': { mode: 'approval', write: 'billing:write', read: 'billing:read' },
  'package.update': { mode: 'approval', write: 'billing:write', read: 'billing:read' },
  'rights.grant': { mode: 'approval', write: 'rights:write', read: 'rights:read' },
  'rights.revoke': { mode: 'review', write: 'rights:write', read: 'rights:read' },
  // A promo code is a discount on revenue (up to 100 %): made by two people, like a price.
  'promo.create': { mode: 'approval', write: 'billing:write', read: 'billing:read' },
};

export interface ChangeRequestState {
  kind: ChangeKind;
  mode: ChangeMode;
  status: ChangeStatus;
  requestedBy: string;
  requestedAt: Date;
}

/** Who decides: permissions plus when their current MFA factor was enrolled. */
export interface ChangeDecider {
  id: string;
  permissions: ReadonlySet<Permission>;
  mfaEnrolledAt: Date | null;
}

export type ChangeDecision = 'approve' | 'reject' | 'withdraw' | 'review';

/** Whether `actor` may take `decision` on the request; the reason when not. */
export function decisionProblem(request: ChangeRequestState, decision: ChangeDecision, actor: ChangeDecider): string | null {
  const policy = CHANGE_POLICY[request.kind];
  const own = actor.id === request.requestedBy;
  switch (decision) {
    case 'withdraw':
      if (!own) return 'Only the person who requested a change can withdraw it.';
      if (request.mode !== 'approval' || request.status !== 'pending') return 'Only a pending request can be withdrawn.';
      return null;
    case 'approve':
    case 'reject':
      if (request.mode !== 'approval' || request.status !== 'pending') return 'This request is no longer pending.';
      break;
    case 'review':
      if (request.mode !== 'review' || request.status !== 'applied') return 'This change does not need a review.';
      break;
  }
  if (own) return 'A change needs a second person: you cannot decide on your own request.';
  if (!actor.permissions.has(policy.write)) return 'Your role cannot decide on this kind of change.';
  // An MFA factor enrolled after the request means the account may have been reset (possibly by
  // the requester, if they can manage staff) and taken over: that account cannot be the second pair of eyes.
  if (!actor.mfaEnrolledAt || actor.mfaEnrolledAt > request.requestedAt) {
    return 'Your MFA was set up after this request was made, so another person has to decide on it.';
  }
  return null;
}

/** The status a decision leads to (approve → applied once the change is in). */
export function statusAfter(decision: ChangeDecision): ChangeStatus {
  switch (decision) {
    case 'approve':
      return 'applied';
    case 'reject':
      return 'rejected';
    case 'withdraw':
      return 'withdrawn';
    case 'review':
      return 'reviewed';
  }
}

/** Open = needs someone's attention (pending approval, or applied and awaiting review). */
export function isOpen(request: Pick<ChangeRequestState, 'mode' | 'status'>): boolean {
  return request.status === 'pending' || (request.mode === 'review' && request.status === 'applied');
}
