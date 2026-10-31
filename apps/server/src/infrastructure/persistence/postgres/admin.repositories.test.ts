import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../../application/admin/audit.service.js';
import { createOutboxWorker, outboxRetryDelayMs } from '../../../application/outbox/outbox-dispatcher.js';
import { newEntityId } from '../../../domain/shared/ids.js';
import { createLogger } from '../../logger.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { PgAdminUnitOfWork, PgAuditRepository, PgOutboxRepository } from './repositories/admin.repository.js';

const logger = createLogger({ log: { level: 'silent' }, env: 'test' });

describe.skipIf(!TEST_DATABASE_URL)('Operator persistence', () => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => testDb?.close());

  it('concurrent audit appends from many transactions keep one unbroken chain', async () => {
    const uow = new PgAdminUnitOfWork(testDb.database.db);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        uow.run((tx) => tx.audit.append({ occurredAt: new Date(), actorId: null, actorEmail: 'test', action: `a.${i}`, targetType: null, targetId: null, beforeHash: null, afterHash: null, details: { i }, ip: null })),
      ),
    );
    const verification = await new AuditService(new PgAuditRepository(testDb.database.db, false)).verify();
    expect(verification).toMatchObject({ checked: 25, intact: true });
    // Appending outside a transaction would not hold the chain lock: refused.
    await expect(new PgAuditRepository(testDb.database.db, false).append({ occurredAt: new Date(), actorId: null, actorEmail: null, action: 'x', targetType: null, targetId: null, beforeHash: null, afterHash: null, details: {}, ip: null })).rejects.toThrow(/unit of work/);
  });

  it('a failed unit of work rolls back the change and its audit entry together', async () => {
    const uow = new PgAdminUnitOfWork(testDb.database.db);
    const before = (await new PgAuditRepository(testDb.database.db, false).list({ limit: 1000 })).length;
    await expect(
      uow.run(async (tx) => {
        await tx.audit.append({ occurredAt: new Date(), actorId: null, actorEmail: 'test', action: 'doomed', targetType: null, targetId: null, beforeHash: null, afterHash: null, details: {}, ip: null });
        await tx.outbox.enqueue({ id: newEntityId(), topic: 'doomed', payload: {}, now: new Date() });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await new PgAuditRepository(testDb.database.db, false).list({ limit: 1000 })).length).toBe(before);
    expect((await new PgOutboxRepository(testDb.database.db).stats()).pending).toBe(0);
  });

  it('outbox: delivers, retries with backoff, parks unknown topics, never double-claims', async () => {
    const outbox = new PgOutboxRepository(testDb.database.db);
    let now = new Date('2026-01-01T00:00:00Z');
    const clock = { now: () => now };
    for (const topic of ['ok', 'flaky', 'unknown']) await outbox.enqueue({ id: newEntityId(), topic, payload: { topic }, now });

    // Two instances claiming at once split the work; nothing is claimed twice.
    const [a, b] = await Promise.all([outbox.claim('a', now, new Date(now.getTime() + 60_000), 2), outbox.claim('b', now, new Date(now.getTime() + 60_000), 2)]);
    expect(a.length + b.length).toBe(3);
    expect(new Set([...a, ...b].map((m) => m.id)).size).toBe(3);
    for (const message of [...a, ...b]) await outbox.fail(message.id, a.includes(message) ? 'a' : 'b', 'test reset', now);

    let flakyCalls = 0;
    const delivered: string[] = [];
    const worker = createOutboxWorker({
      outbox,
      clock,
      logger,
      handlers: {
        ok: async (payload) => void delivered.push(String(payload.topic)),
        flaky: async () => {
          flakyCalls++;
          if (flakyCalls < 2) throw new Error('temporary');
          delivered.push('flaky');
        },
      },
    });
    const run = async () => {
      const task = await worker.claim('w', now, new Date(now.getTime() + 60_000));
      await task?.run({ owner: 'w', signal: new AbortController().signal });
      return task !== null;
    };
    await run();
    expect(delivered).toEqual(['ok']);
    expect(await outbox.stats()).toEqual({ pending: 2, failing: 2 });

    expect(await run()).toBe(false); // flaky waits for its backoff; unknown is parked forever
    now = new Date(now.getTime() + outboxRetryDelayMs(2) + 1_000);
    await run();
    expect(delivered).toEqual(['ok', 'flaky']);
    expect(await outbox.stats()).toEqual({ pending: 1, failing: 1 });
    now = new Date(now.getTime() + 365 * 86_400_000);
    expect(await run()).toBe(false);
  });
});
