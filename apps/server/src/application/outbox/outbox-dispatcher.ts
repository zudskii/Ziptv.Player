import type { Worker } from '../jobs/job-runner.js';
import type { OutboxMessage, OutboxRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';

export const OUTBOX_JOB = 'outbox';
const BATCH = 20;
const MAX_ATTEMPTS = 10;
const LEASE_MS = 2 * 60_000;

export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

/** Retry delay after the n-th failed attempt: 30 s, 1 min, 2 min … capped at 1 h. */
export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Delivers outbox messages (written in the same transaction as the change that caused them) to
 * their handlers — at least once, so handlers must be idempotent. Failures retry with backoff;
 * after MAX_ATTEMPTS a message is parked with its last error for an operator to inspect.
 */
export function createOutboxWorker(deps: { outbox: OutboxRepository; handlers: Record<string, OutboxHandler>; clock: Clock; logger: Logger }): Worker {
  const deliver = async (message: OutboxMessage, owner: string): Promise<void> => {
    const handler = deps.handlers[message.topic];
    try {
      if (!handler) throw new Error(`No handler for outbox topic "${message.topic}"`);
      await handler(message.payload);
      await deps.outbox.complete(message.id, owner, deps.clock.now());
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const giveUp = !handler || message.attempts >= MAX_ATTEMPTS;
      const retryAt = giveUp ? null : new Date(deps.clock.now().getTime() + outboxRetryDelayMs(message.attempts));
      await deps.outbox.fail(message.id, owner, text, retryAt);
      deps.logger.warn({ err: error, topic: message.topic, id: message.id, attempts: message.attempts, parked: giveUp }, 'Outbox delivery failed');
    }
  };

  return {
    name: OUTBOX_JOB,
    pollIntervalMs: 5_000,
    concurrency: 1,
    leaseMs: LEASE_MS,
    claim: async (owner, now, leaseUntil) => {
      const messages = await deps.outbox.claim(owner, now, leaseUntil, BATCH);
      if (messages.length === 0) return null;
      return {
        label: `outbox ×${messages.length}`,
        // A slow batch (SMTP timeouts) keeps its lease, so another instance does not deliver it twice.
        heartbeat: (owner, leaseUntil) => deps.outbox.extendLease(messages.map((message) => message.id), owner, leaseUntil),
        run: async (lease) => {
          for (const message of messages) {
            if (lease.signal.aborted) return; // unprocessed messages are re-claimed after the lease
            await deliver(message, lease.owner);
          }
        },
      };
    },
  };
}
