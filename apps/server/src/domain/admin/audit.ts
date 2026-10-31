import { createHash } from 'node:crypto';

/**
 * Tamper-evident audit trail (pure part). Every entry stores the hash of its predecessor and
 * its own hash over a canonical serialisation, so deleting, editing or re-ordering any past
 * entry breaks every hash after it. (The database additionally refuses UPDATE/DELETE.)
 */

export interface AuditFields {
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  prevHash: string;
}

export const AUDIT_GENESIS = '0'.repeat(64);

/** JSON with sorted keys at every level: the same object always serialises the same way. */
export function canonicalJson(value: unknown): string {
  // Same conversion JSON storage applies (Date → ISO string), so what is hashed is what is stored.
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function auditHash(fields: AuditFields): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}

/** Fingerprint of a record's state before/after a change (the state itself is not stored). */
export function stateHash(state: unknown): string | null {
  return state === null || state === undefined ? null : createHash('sha256').update(canonicalJson(state)).digest('hex');
}

/** First broken entry of a chain in seq order, or null when it is intact. */
export function verifyAuditChain(entries: readonly (AuditFields & { hash: string })[], startPrev = AUDIT_GENESIS): { seq: number; reason: string } | null {
  let prev = startPrev;
  for (const entry of entries) {
    if (entry.prevHash !== prev) return { seq: entry.seq, reason: 'previous hash does not match' };
    const { hash, ...fields } = entry;
    if (auditHash(fields) !== hash) return { seq: entry.seq, reason: 'entry content was changed' };
    prev = hash;
  }
  return null;
}
