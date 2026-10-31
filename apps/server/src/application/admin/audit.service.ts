import type { AuditEntryDto, AuditPageDto, AuditVerificationDto } from '@ziptv/contracts';

import { AUDIT_GENESIS, verifyAuditChain, type AuditFields } from '../../domain/admin/audit.js';
import type { AuditFilter, AuditRecord, AuditRepository } from '../ports/admin.js';

const BATCH = 1_000;

export function toAuditFields(record: AuditRecord): AuditFields & { hash: string } {
  return {
    seq: record.seq,
    occurredAt: record.occurredAt.toISOString(),
    actorId: record.actorId,
    actorEmail: record.actorEmail,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    details: record.details,
    ip: record.ip,
    prevHash: record.prevHash,
    hash: record.hash,
  };
}

function toDto(record: AuditRecord): AuditEntryDto {
  return {
    seq: record.seq,
    occurredAt: record.occurredAt.toISOString(),
    actorId: record.actorId,
    actorEmail: record.actorEmail,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    details: record.details,
    ip: record.ip,
    hash: record.hash,
  };
}

/** Reading and verifying the audit trail (writing happens inside each admin use case). */
export class AuditService {
  constructor(private readonly audit: AuditRepository) {}

  async list(filter: AuditFilter): Promise<AuditPageDto> {
    const rows = await this.audit.list({ ...filter, limit: filter.limit + 1 });
    const items = rows.slice(0, filter.limit);
    return { items: items.map(toDto), nextBefore: rows.length > filter.limit ? (items[items.length - 1]?.seq ?? null) : null };
  }

  /** Re-computes every hash from the first entry; the first mismatch means tampering. */
  async verify(): Promise<AuditVerificationDto> {
    let prev = AUDIT_GENESIS;
    let checked = 0;
    for await (const batch of this.audit.readBatches(BATCH)) {
      const fields = batch.map(toAuditFields);
      const broken = verifyAuditChain(fields, prev);
      if (broken) return { checked: checked + fields.findIndex((f) => f.seq === broken.seq), intact: false, brokenAt: broken, headHash: null };
      checked += fields.length;
      prev = fields[fields.length - 1]!.hash;
    }
    return { checked, intact: true, brokenAt: null, headHash: checked > 0 ? prev : null };
  }
}
