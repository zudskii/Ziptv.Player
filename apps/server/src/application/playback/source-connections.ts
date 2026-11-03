import { AppError } from '../errors.js';
import type { LeaseStore } from '../ports/lease-store.js';
import type { SourceRecord } from '../ports/source-repository.js';

/** A viewing that stops reporting (closed tab, crash) frees its connection after this long. */
export const SOURCE_LEASE_TTL_MS = 120_000;

const key = (sourceId: string) => `byo-connections:${sourceId}`;

/**
 * The subscriber's own Xtream account allows `max_connections` simultaneous streams. Viewings of
 * that source (several players in Multi-view, other devices) each hold a lease on one of them, so
 * the next one gets a clear "too many streams" instead of a provider error mid-play. The holder is
 * the viewing (plan session id): reconnects keep it, `replaces` frees the one a player moves away
 * from, heartbeats renew it and `stop` releases it; a silent viewing expires on its own.
 */
export class SourceConnections {
  constructor(private readonly leases: LeaseStore) {}

  /** The account's connection limit, when it has one. */
  limitOf(source: Pick<SourceRecord, 'type' | 'account'>): number | null {
    const limit = source.type === 'xtream' ? source.account?.maxConnections : null;
    return limit && limit > 0 ? limit : null;
  }

  async acquire(source: Pick<SourceRecord, 'id' | 'type' | 'account'>, holder: string, replaces?: string): Promise<void> {
    const limit = this.limitOf(source);
    if (!limit) return;
    if (replaces && replaces !== holder) await this.leases.release(key(source.id), replaces);
    const lease = await this.leases.acquire(key(source.id), holder, { limit, ttlMs: SOURCE_LEASE_TTL_MS });
    if (!lease.acquired) {
      throw new AppError('CONCURRENCY_LIMIT', 409, `Your provider account allows ${limit} simultaneous stream${limit === 1 ? '' : 's'}. Stop another player first.`, {
        reason: 'source_connections',
        limit,
        playing: [],
      });
    }
  }

  /** Heartbeat of a viewing: keeps its connection (takes it again if it lapsed and one is free). */
  async renew(source: Pick<SourceRecord, 'id' | 'type' | 'account'>, holder: string): Promise<void> {
    const limit = this.limitOf(source);
    if (!limit) return;
    if (await this.leases.renew(key(source.id), holder, SOURCE_LEASE_TTL_MS)) return;
    await this.leases.acquire(key(source.id), holder, { limit, ttlMs: SOURCE_LEASE_TTL_MS });
  }

  async release(sourceId: string, holder: string): Promise<void> {
    await this.leases.release(key(sourceId), holder);
  }
}
