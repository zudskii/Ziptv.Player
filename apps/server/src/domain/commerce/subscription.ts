/**
 * Subscription lifecycle (ZP-ENT-07). Pure: every change is an event applied to a state; time is an
 * event too (`tick`), so the clock job, webhooks and tests all go through the same function.
 *
 *   trialing ──payment──► active ──period ends, no payment──► past_due ──► grace ──► expired
 *       │                   ▲  │                                │           │
 *       │                   └──┼──────────── payment ───────────┴───────────┘
 *       └─ trial ends unpaid ──┘ (past_due)
 *   an unpaid trial (nothing ever paid) gets the past_due retry window only, then expires
 *   cancel at period end: access until the paid period ends, then canceled
 *   cancel now / refund:  canceled immediately
 *
 * Access: trialing, active, past_due and grace (dunning keeps the viewer watching while payment is
 * retried); canceled and expired never. `accessUntil` gives the latest moment access can last
 * without a further event, so an entitlement ends on time even if the clock job lags.
 */

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'grace', 'canceled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionState {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
}

export interface DunningPolicy {
  /** past_due: renewal is being retried (access kept). */
  pastDueMs: number;
  /** grace: last warning before expiry (access kept). */
  graceMs: number;
}

export const DEFAULT_DUNNING: DunningPolicy = { pastDueMs: 3 * 86_400_000, graceMs: 4 * 86_400_000 };

export type SubscriptionEvent =
  | { type: 'payment_succeeded'; at: Date; periodStart: Date; periodEnd: Date }
  | { type: 'payment_failed'; at: Date }
  | { type: 'cancel_requested'; at: Date; atPeriodEnd: boolean }
  | { type: 'cancel_withdrawn'; at: Date }
  | { type: 'refunded'; at: Date }
  | { type: 'tick'; at: Date };

export interface Transition {
  state: SubscriptionState;
  /** Status before → after (equal when only fields changed or nothing happened). */
  from: SubscriptionStatus;
  to: SubscriptionStatus;
  changed: boolean;
  /** Why an event did not apply (out-of-order / duplicate webhook, terminal state, …). */
  ignored: string | null;
}

export function isTerminal(status: SubscriptionStatus): boolean {
  return status === 'canceled' || status === 'expired';
}

export function grantsAccess(status: SubscriptionStatus): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due' || status === 'grace';
}

/** A new subscription: a trial, or a first paid period. */
export function startSubscription(input: { at: Date; trialEndsAt?: Date | null; periodStart?: Date; periodEnd?: Date }): SubscriptionState {
  if (input.trialEndsAt) {
    if (input.trialEndsAt <= input.at) throw new Error('A trial must end in the future');
    return { status: 'trialing', trialEndsAt: input.trialEndsAt, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, endedAt: null };
  }
  if (!input.periodStart || !input.periodEnd || input.periodEnd <= input.periodStart) throw new Error('A paid subscription needs a period');
  return { status: 'active', trialEndsAt: null, currentPeriodStart: input.periodStart, currentPeriodEnd: input.periodEnd, cancelAtPeriodEnd: false, endedAt: null };
}

/** When the paid (or trial) time runs out: the anchor of dunning. */
function anchor(state: SubscriptionState): Date | null {
  return state.currentPeriodEnd ?? state.trialEndsAt;
}

export function applySubscriptionEvent(current: SubscriptionState, event: SubscriptionEvent, policy: DunningPolicy = DEFAULT_DUNNING): Transition {
  const result = (state: SubscriptionState, ignored: string | null = null): Transition => ({
    state,
    from: current.status,
    to: state.status,
    changed: JSON.stringify(state) !== JSON.stringify(current),
    ignored,
  });
  if (isTerminal(current.status)) return result(current, `subscription is ${current.status}`);
  // Time first: an event is judged against the state at its own time.
  const base = event.type === 'tick' ? current : advance(current, event.at, policy);

  switch (event.type) {
    case 'tick':
      return result(advance(current, event.at, policy));

    case 'payment_succeeded': {
      if (isTerminal(base.status)) return result(base, `subscription is ${base.status}`);
      // Webhooks arrive late, twice, or out of order: only a period that extends access counts.
      if (base.currentPeriodEnd && event.periodEnd <= base.currentPeriodEnd) return result(base, 'period already covered');
      if (event.periodEnd <= event.periodStart) return result(base, 'invalid period');
      return result({ ...base, status: 'active', currentPeriodStart: event.periodStart, currentPeriodEnd: event.periodEnd, endedAt: null });
    }

    case 'payment_failed': {
      if (isTerminal(base.status)) return result(base, `subscription is ${base.status}`);
      const due = anchor(base);
      // A renewal/conversion charge failed: only meaningful once the paid time is over.
      if (base.status === 'active' || base.status === 'trialing') {
        if (!due || event.at < due) return result(base, 'paid period still running');
        return result({ ...base, status: 'past_due' });
      }
      return result(base, 'already in dunning');
    }

    case 'cancel_requested': {
      if (isTerminal(base.status)) return result(base, `subscription is ${base.status}`);
      // Nothing paid is left in dunning: cancelling there ends access now.
      if (!event.atPeriodEnd || base.status === 'past_due' || base.status === 'grace') {
        return result({ ...base, status: 'canceled', cancelAtPeriodEnd: false, endedAt: event.at });
      }
      return result({ ...base, cancelAtPeriodEnd: true });
    }

    case 'cancel_withdrawn': {
      if (!base.cancelAtPeriodEnd || isTerminal(base.status)) return result(base, 'nothing to withdraw');
      return result({ ...base, cancelAtPeriodEnd: false });
    }

    case 'refunded':
      if (isTerminal(base.status)) return result(base, `subscription is ${base.status}`);
      return result({ ...base, status: 'canceled', cancelAtPeriodEnd: false, endedAt: event.at });
  }
}

/** Applies the passage of time until the state is stable at `at`. */
function advance(state: SubscriptionState, at: Date, policy: DunningPolicy): SubscriptionState {
  let next = state;
  for (let i = 0; i < 5; i++) {
    const step = advanceOnce(next, at, policy);
    if (step === next) return next;
    next = step;
  }
  return next;
}

function advanceOnce(state: SubscriptionState, at: Date, policy: DunningPolicy): SubscriptionState {
  const due = anchor(state);
  if (!due) return state;
  switch (state.status) {
    case 'trialing':
    case 'active':
      if (at < due) return state;
      return state.cancelAtPeriodEnd ? { ...state, status: 'canceled', cancelAtPeriodEnd: false, endedAt: due } : { ...state, status: 'past_due' };
    case 'past_due':
      if (at.getTime() < due.getTime() + policy.pastDueMs) return state;
      // Never paid (a trial that did not convert): no grace on top of the retries.
      return neverPaid(state) ? { ...state, status: 'expired', endedAt: new Date(due.getTime() + policy.pastDueMs) } : { ...state, status: 'grace' };
    case 'grace': {
      const end = new Date(due.getTime() + policy.pastDueMs + policy.graceMs);
      return at >= end ? { ...state, status: 'expired', endedAt: end } : state;
    }
    default:
      return state;
  }
}

/**
 * The latest moment the subscription gives access without a further event (null = no access).
 * Paying moves it forward; cancelling at period end pulls it back to the period end.
 */
export function accessUntil(state: SubscriptionState, policy: DunningPolicy = DEFAULT_DUNNING): Date | null {
  if (isTerminal(state.status)) return null;
  const due = anchor(state);
  if (!due) return null;
  if (state.cancelAtPeriodEnd && (state.status === 'trialing' || state.status === 'active')) return due;
  return new Date(due.getTime() + policy.pastDueMs + (neverPaid(state) ? 0 : policy.graceMs));
}

function neverPaid(state: SubscriptionState): boolean {
  return state.currentPeriodEnd === null;
}

/** Adds one billing period (calendar months/years, clamped to the month's last day). */
export function addPeriod(from: Date, period: 'month' | 'year'): Date {
  const result = new Date(from);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + (period === 'year' ? 12 : 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
