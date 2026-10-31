import type { LeaseStore } from '../../application/ports/lease-store.js';

/** Single-instance LeaseStore (development, tests, one replica). Same semantics as the Redis one. */
export class MemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(key: string, holder: string, options: { limit: number; ttlMs: number }): Promise<{ acquired: boolean; holders: number }> {
    const holders = this.live(key);
    if (holders.has(holder) || holders.size < options.limit) {
      holders.set(holder, this.now() + options.ttlMs);
      this.leases.set(key, holders);
      return { acquired: true, holders: holders.size };
    }
    return { acquired: false, holders: holders.size };
  }

  async renew(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const holders = this.live(key);
    if (!holders.has(holder)) return false;
    holders.set(holder, this.now() + ttlMs);
    return true;
  }

  async release(key: string, holder: string): Promise<void> {
    const holders = this.leases.get(key);
    holders?.delete(holder);
    if (holders?.size === 0) this.leases.delete(key);
  }

  async holders(key: string): Promise<string[]> {
    return [...this.live(key).keys()];
  }

  private live(key: string): Map<string, number> {
    const holders = this.leases.get(key) ?? new Map<string, number>();
    const now = this.now();
    for (const [holder, expiresAt] of holders) if (expiresAt <= now) holders.delete(holder);
    if (holders.size === 0) this.leases.delete(key);
    return holders;
  }
}
