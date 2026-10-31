import type { Cache } from '../../application/ports/cache.js';
import type { InvalidationBus } from '../../application/ports/invalidation-bus.js';

/**
 * Local in-process cache whose invalidations reach every instance.
 *
 * Reads stay in memory (no network hop on the hot path); `delete` / `deleteByPrefix` apply here
 * and are broadcast, so e.g. a source re-sync on instance A drops the channel lists instance B
 * cached, and a revoked stream grant is forgotten everywhere.
 */
export class CoherentCache implements Cache {
  constructor(
    private readonly local: Cache,
    private readonly bus: InvalidationBus,
  ) {
    bus.subscribe((message) => {
      if (message.type === 'key') local.delete(message.key);
      else local.deleteByPrefix(message.prefix);
    });
  }

  get<T>(key: string): T | undefined {
    return this.local.get<T>(key);
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.local.set(key, value, ttlMs);
  }

  delete(key: string): void {
    this.local.delete(key);
    this.bus.publish({ type: 'key', key });
  }

  deleteByPrefix(prefix: string): void {
    this.local.deleteByPrefix(prefix);
    this.bus.publish({ type: 'prefix', prefix });
  }

  wrap<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
    return this.local.wrap(key, ttlMs, factory);
  }
}
