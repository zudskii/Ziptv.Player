import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { ChangeKind } from '../../../../domain/admin/change-requests.js';
import { isEntityId } from '../../../../domain/shared/ids.js';
import type { ChangeRequestFilter, ChangeRequestRecord, ChangeRequestRepository } from '../../../../application/ports/admin.js';
import type { Db } from '../database.js';
import { json, type ChangeRequestsTable, type Database } from '../schema.js';

const OPEN = sql<SqlBool>`(cr.status = 'pending' OR (cr.mode = 'review' AND cr.status = 'applied'))`;

/** Four-eyes change requests, with the requester and decider resolved for display. */
export class PgChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly db: Db) {}

  async create(record: Omit<ChangeRequestRecord, 'requestedBy' | 'decidedBy'> & { requestedBy: string; decidedBy: string | null }): Promise<void> {
    await this.db
      .insertInto('change_requests')
      .values({
        id: record.id,
        kind: record.kind,
        mode: record.mode,
        status: record.status,
        target_type: record.targetType,
        target_id: record.targetId,
        payload: json(record.payload),
        summary: record.summary,
        base_hash: record.baseHash,
        requested_by: record.requestedBy,
        requested_at: record.requestedAt,
        decided_by: record.decidedBy,
        decided_at: record.decidedAt,
        decision_note: record.decisionNote,
        error: record.error,
      })
      .execute();
  }

  async find(id: string, options: { lock?: boolean } = {}): Promise<ChangeRequestRecord | null> {
    if (!isEntityId(id)) return null;
    if (options.lock) await this.db.selectFrom('change_requests').select('id').where('id', '=', id).forUpdate().execute();
    const row = await this.base().where('cr.id', '=', id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async list(filter: ChangeRequestFilter): Promise<{ items: ChangeRequestRecord[]; total: number }> {
    if (filter.kinds.length === 0) return { items: [], total: 0 };
    const where = (eb: ExpressionBuilder<Database & { cr: ChangeRequestsTable }, 'cr'>) => {
      const parts: Expression<SqlBool>[] = [eb('cr.kind', 'in', [...filter.kinds])];
      if (filter.status === 'open') parts.push(OPEN);
      else if (filter.status) parts.push(eb('cr.status', '=', filter.status));
      if (filter.targetType) parts.push(eb('cr.target_type', '=', filter.targetType));
      if (filter.targetId && isEntityId(filter.targetId)) parts.push(eb('cr.target_id', '=', filter.targetId));
      return eb.and(parts);
    };
    const [rows, total] = await Promise.all([
      this.base().where(where).orderBy('cr.requested_at', 'desc').offset(filter.offset).limit(filter.limit).execute(),
      this.db.selectFrom('change_requests as cr').select((eb) => eb.fn.countAll<string>().as('n')).where(where).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toRecord), total: Number(total.n) };
  }

  async countOpen(kinds: readonly ChangeKind[]): Promise<number> {
    if (kinds.length === 0) return 0;
    const row = await this.db.selectFrom('change_requests as cr').select((eb) => eb.fn.countAll<string>().as('n')).where('cr.kind', 'in', [...kinds]).where(OPEN).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async decide(id: string, decision: { status: ChangeRequestRecord['status']; decidedBy: string | null; decidedAt: Date; note: string | null; error: string | null }): Promise<void> {
    await this.db
      .updateTable('change_requests')
      .set({ status: decision.status, decided_by: decision.decidedBy, decided_at: decision.decidedAt, decision_note: decision.note, error: decision.error })
      .where('id', '=', id)
      .execute();
  }

  private base() {
    return this.db
      .selectFrom('change_requests as cr')
      .innerJoin('staff_users as rq', 'rq.id', 'cr.requested_by')
      .leftJoin('staff_users as dc', 'dc.id', 'cr.decided_by')
      .selectAll('cr')
      .select(['rq.email as rq_email', 'rq.name as rq_name', 'dc.email as dc_email', 'dc.name as dc_name']);
  }
}

type Row = Awaited<ReturnType<ReturnType<PgChangeRequestRepository['base']>['executeTakeFirstOrThrow']>>;

function toRecord(row: Row): ChangeRequestRecord {
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
    summary: row.summary,
    baseHash: row.base_hash,
    requestedBy: { id: row.requested_by, email: row.rq_email, name: row.rq_name },
    requestedAt: row.requested_at,
    decidedBy: row.decided_by && row.dc_email ? { id: row.decided_by, email: row.dc_email, name: row.dc_name ?? '' } : null,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    error: row.error,
  };
}
