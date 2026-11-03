import type { ChangeRequestDto, ChangeRequestKind, ChangeRequestPageDto, ChangeRequestStatus } from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { CHANGE_KINDS, CHANGE_POLICY, decisionProblem, isOpen, statusAfter, type ChangeDecision, type ChangeKind } from '../../domain/admin/change-requests.js';
import { newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork, ChangeRequestRecord, ChangeRequestRepository, StaffRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import { actorOf, type AdminContext, type StaffPrincipal } from './principal.js';

type Decider = StaffPrincipal & { mfaEnrolledAt: Date | null };

/**
 * One kind of four-eyes change, implemented by the service that owns the target. `prepare`
 * validates when the change is requested; `apply` runs inside the approver's transaction (and
 * validates again: the world may have changed); `afterCommit` clears caches / stops viewings.
 */
export interface ChangeHandler {
  kind: ChangeKind;
  targetType: string;
  prepare(payload: Record<string, unknown>, targetId: string | null): Promise<{ payload: Record<string, unknown>; summary: string; base: unknown }>;
  /** The target's current state (inside the transaction) — an approval of a stale request fails. */
  current?(tx: AdminTransaction, targetId: string): Promise<unknown>;
  apply(tx: AdminTransaction, actor: StaffPrincipal, change: AppliedChange, context: AdminContext): Promise<{ targetId: string; result: unknown }>;
  afterCommit?(change: AppliedChange, result: unknown): Promise<void>;
}

export interface AppliedChange {
  requestId: string;
  requestedBy: string;
  requestedAt: Date;
  targetId: string | null;
  payload: Record<string, unknown>;
}

/** A pending approval goes stale: after this it can only fail (the requester asks again). */
const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a change request led to: applied now (four-eyes off), or waiting for a second person. */
export type ProposalOutcome = { status: 'applied'; result: unknown; request: ChangeRequestDto } | { status: 'pending'; request: ChangeRequestDto };

/** Refusals that must not mark the request failed (who may decide, not whether the change works). */
class DecisionRefused extends AppError {}

/**
 * Four-eyes control of the console (Phase 9.6). Requests, decisions and the applied change are
 * all audited; an approval applies the change in the same transaction that records it, so a
 * request is `applied` exactly when its change is in.
 */
export class ChangeRequestService {
  private readonly handlers = new Map<ChangeKind, ChangeHandler>();

  constructor(
    private readonly deps: {
      uow: AdminUnitOfWork;
      requests: ChangeRequestRepository;
      staff: Pick<StaffRepository, 'findById'>;
      clock: Clock;
      logger: Logger;
      /** Off only outside production (enforced by the configuration). */
      fourEyes: boolean;
    },
  ) {}

  register(...handlers: ChangeHandler[]): this {
    for (const handler of handlers) this.handlers.set(handler.kind, handler);
    return this;
  }

  get fourEyes(): boolean {
    return this.deps.fourEyes;
  }

  /** A change that needs approval: queued for a second person (or applied now with four-eyes off). */
  async propose(actor: StaffPrincipal, kind: ChangeKind, targetId: string | null, payload: Record<string, unknown>, context: AdminContext): Promise<ProposalOutcome> {
    const policy = CHANGE_POLICY[kind];
    if (policy.mode !== 'approval') throw new Error(`${kind} is not requested for approval`);
    if (!actor.permissions.has(policy.write)) throw new AppError('FORBIDDEN', 403, 'Your role cannot request this change.');
    const handler = this.handler(kind);
    const prepared = await handler.prepare(payload, targetId);
    const now = this.deps.clock.now();
    const id = newEntityId();
    const base = { id, kind, mode: policy.mode, targetType: handler.targetType, targetId, payload: prepared.payload, summary: prepared.summary, baseHash: prepared.base === null ? null : stateHash(prepared.base), requestedAt: now, decisionNote: null, error: null };

    if (!this.deps.fourEyes) {
      const outcome = await this.write(async (tx) => {
        const applied = await handler.apply(tx, actor, { requestId: id, requestedBy: actor.id, requestedAt: now, targetId, payload: prepared.payload }, context);
        await tx.changeRequests.create({ ...base, targetId: applied.targetId, status: 'applied', requestedBy: actor.id, decidedBy: null, decidedAt: now, decisionNote: 'four-eyes disabled' });
        await this.audit(tx, actor, context, 'change.applied_without_approval', { id, kind, targetId: applied.targetId, summary: prepared.summary });
        return applied;
      }, 'The change conflicts with the current state (for example, the name or slug is taken).');
      await handler.afterCommit?.({ requestId: id, requestedBy: actor.id, requestedAt: now, targetId: outcome.targetId, payload: prepared.payload }, outcome.result);
      return { status: 'applied', result: outcome.result, request: await this.dto(actor, id) };
    }

    await this.write(async (tx) => {
      await tx.changeRequests.create({ ...base, status: 'pending', requestedBy: actor.id, decidedBy: null, decidedAt: null });
      await this.audit(tx, actor, context, 'change.requested', { id, kind, targetType: handler.targetType, targetId, summary: prepared.summary });
    }, 'A change to this item is already waiting for approval. Withdraw it or ask for a decision first.');
    this.deps.logger.info({ requestId: id, kind, targetId, by: actor.email }, 'Change requested (four-eyes)');
    return { status: 'pending', request: await this.dto(actor, id) };
  }

  /**
   * An emergency change that has already been applied in `tx` (a rights revocation): recorded for
   * a second person's review. Nothing to do with four-eyes off.
   */
  async recordForReview(tx: AdminTransaction, actor: StaffPrincipal, input: { kind: ChangeKind; targetType: string; targetId: string; payload: Record<string, unknown>; summary: string }, context: AdminContext): Promise<void> {
    if (!this.deps.fourEyes) return;
    if (CHANGE_POLICY[input.kind].mode !== 'review') throw new Error(`${input.kind} is not reviewed afterwards`);
    const id = newEntityId();
    await tx.changeRequests.create({ id, kind: input.kind, mode: 'review', status: 'applied', targetType: input.targetType, targetId: input.targetId, payload: input.payload, summary: input.summary, baseHash: null, requestedBy: actor.id, requestedAt: this.deps.clock.now(), decidedBy: null, decidedAt: null, decisionNote: null, error: null });
    await this.audit(tx, actor, context, 'change.awaiting_review', { id, kind: input.kind, targetId: input.targetId, summary: input.summary });
  }

  async decide(principal: StaffPrincipal, id: string, decision: ChangeDecision, note: string | null, context: AdminContext): Promise<ChangeRequestDto> {
    const request = await this.deps.requests.find(id);
    if (!request || !this.visible(principal, request.kind)) throw AppError.notFound('Change request');
    const actor = await this.decider(principal);
    this.check(request, decision, actor);
    const trimmed = note?.trim() || null;
    if (decision === 'reject' && !trimmed) throw AppError.validation('Say why the change is rejected.');

    if (decision !== 'approve') {
      await this.write(async (tx) => {
        const locked = await this.lock(tx, id);
        this.check(locked, decision, actor);
        await tx.changeRequests.decide(id, { status: statusAfter(decision), decidedBy: actor.id, decidedAt: this.deps.clock.now(), note: trimmed, error: null });
        await this.audit(tx, actor, context, `change.${decision === 'review' ? 'reviewed' : decision === 'reject' ? 'rejected' : 'withdrawn'}`, { id, kind: locked.kind, targetId: locked.targetId, note: trimmed });
      });
      return this.dto(actor, id);
    }

    const handler = this.handler(request.kind);
    let applied: { targetId: string; result: unknown; change: AppliedChange };
    try {
      applied = await this.write(async (tx) => {
        const locked = await this.lock(tx, id);
        this.check(locked, 'approve', actor);
        if (this.deps.clock.now().getTime() - locked.requestedAt.getTime() > APPROVAL_TTL_MS) {
          throw new AppError('CONFLICT', 409, 'This request is older than 30 days and has expired. Ask for a new request.');
        }
        if (locked.baseHash && locked.targetId && handler.current) {
          const current = stateHash(await handler.current(tx, locked.targetId));
          if (current !== locked.baseHash) throw new AppError('CONFLICT', 409, 'The item changed after this request was made. Ask for a new request.');
        }
        const change: AppliedChange = { requestId: id, requestedBy: locked.requestedBy.id, requestedAt: locked.requestedAt, targetId: locked.targetId, payload: locked.payload };
        const result = await handler.apply(tx, actor, change, context);
        await tx.changeRequests.decide(id, { status: 'applied', decidedBy: actor.id, decidedAt: this.deps.clock.now(), note: trimmed, error: null });
        await this.audit(tx, actor, context, 'change.approved', { id, kind: locked.kind, targetId: result.targetId, requestedBy: locked.requestedBy.email, summary: locked.summary });
        return { ...result, change: { ...change, targetId: result.targetId } };
      }, 'The change conflicts with the current state (for example, the name or slug is taken).');
    } catch (error) {
      if (error instanceof DecisionRefused || !(error instanceof AppError) || error.status >= 500) throw error;
      // The change itself no longer works (stale, invalid, conflicting): the request fails, visibly.
      await this.write(async (tx) => {
        const locked = await this.lock(tx, id);
        if (locked.status !== 'pending') return;
        await tx.changeRequests.decide(id, { status: 'failed', decidedBy: actor.id, decidedAt: this.deps.clock.now(), note: trimmed, error: error.message });
        await this.audit(tx, actor, context, 'change.failed', { id, kind: locked.kind, targetId: locked.targetId, error: error.message });
      });
      this.deps.logger.warn({ requestId: id, kind: request.kind, error: error.message }, 'Approved change could not be applied');
      return this.dto(actor, id);
    }
    await handler.afterCommit?.(applied.change, applied.result);
    this.deps.logger.info({ requestId: id, kind: request.kind, by: actor.email, requestedBy: request.requestedBy.email }, 'Change approved and applied');
    return this.dto(actor, id);
  }

  async list(actor: StaffPrincipal, filter: { status?: ChangeRequestStatus | 'open' | undefined; kind?: ChangeRequestKind | undefined; targetId?: string | undefined; offset: number; limit: number }): Promise<ChangeRequestPageDto> {
    const kinds = this.visibleKinds(actor).filter((kind) => !filter.kind || kind === filter.kind);
    const [page, open, decider] = await Promise.all([
      this.deps.requests.list({ kinds, status: filter.status, targetId: filter.targetId, offset: filter.offset, limit: filter.limit }),
      this.deps.requests.countOpen(this.visibleKinds(actor)),
      this.decider(actor),
    ]);
    return { items: page.items.map((record) => toDto(record, decider)), total: page.total, open };
  }

  async get(actor: StaffPrincipal, id: string): Promise<ChangeRequestDto> {
    const record = await this.deps.requests.find(id);
    if (!record || !this.visible(actor, record.kind)) throw AppError.notFound('Change request');
    return toDto(record, await this.decider(actor));
  }

  /** Open requests this staff member could act on (for the navigation badge). */
  async openCount(actor: StaffPrincipal): Promise<number> {
    return this.deps.requests.countOpen(this.visibleKinds(actor));
  }

  // ---------------------------------------------------------------------------------------------

  private check(request: ChangeRequestRecord, decision: ChangeDecision, actor: Decider): void {
    const problem = decisionProblem({ kind: request.kind, mode: request.mode, status: request.status, requestedBy: request.requestedBy.id, requestedAt: request.requestedAt }, decision, actor);
    if (problem) throw new DecisionRefused(isOpen(request) ? 'FORBIDDEN' : 'CONFLICT', isOpen(request) ? 403 : 409, problem);
  }

  private async lock(tx: AdminTransaction, id: string): Promise<ChangeRequestRecord> {
    const locked = await tx.changeRequests.find(id, { lock: true });
    if (!locked) throw new DecisionRefused('NOT_FOUND', 404, 'Change request not found.');
    return locked;
  }

  private handler(kind: ChangeKind): ChangeHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`No handler for ${kind}`);
    return handler;
  }

  private visibleKinds(actor: StaffPrincipal): ChangeKind[] {
    return CHANGE_KINDS.filter((kind) => this.visible(actor, kind));
  }

  private visible(actor: StaffPrincipal, kind: ChangeKind): boolean {
    return actor.permissions.has(CHANGE_POLICY[kind].read) || actor.permissions.has(CHANGE_POLICY[kind].write);
  }

  private async decider(principal: StaffPrincipal): Promise<Decider> {
    const staff = await this.deps.staff.findById(principal.id);
    return { ...principal, mfaEnrolledAt: staff?.mfaEnabledAt ?? null };
  }

  private async dto(actor: StaffPrincipal, id: string): Promise<ChangeRequestDto> {
    const record = await this.deps.requests.find(id);
    if (!record) throw AppError.notFound('Change request');
    return toDto(record, await this.decider(actor));
  }

  private async write<T>(work: (tx: AdminTransaction) => Promise<T>, conflict?: string): Promise<T> {
    try {
      return await this.deps.uow.run(work);
    } catch (error) {
      if (conflict && typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') throw new AppError('CONFLICT', 409, conflict);
      throw error;
    }
  }

  private async audit(tx: AdminTransaction, actor: StaffPrincipal, context: AdminContext, action: string, details: Record<string, unknown>): Promise<void> {
    await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action, targetType: 'change_request', targetId: String(details.id), beforeHash: null, afterHash: null, details });
  }
}

function toDto(record: ChangeRequestRecord, actor: Decider): ChangeRequestDto {
  const state = { kind: record.kind, mode: record.mode, status: record.status, requestedBy: record.requestedBy.id, requestedAt: record.requestedAt };
  const decidable = record.mode === 'approval' ? decisionProblem(state, 'approve', actor) === null : decisionProblem(state, 'review', actor) === null;
  return {
    id: record.id,
    kind: record.kind,
    mode: record.mode,
    status: record.status,
    targetType: record.targetType,
    targetId: record.targetId,
    summary: record.summary,
    payload: record.payload,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt.toISOString(),
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionNote: record.decisionNote,
    error: record.error,
    canDecide: decidable,
    canWithdraw: decisionProblem(state, 'withdraw', actor) === null,
  };
}
