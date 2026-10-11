import type { Cache } from '../../application/ports/cache.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * IMemoryCache-style in-process cache: TTL per entry, LRU eviction, prefix invalidation and
 * request coalescing (`wrap`: 100 concurrent misses on one key run the factory once).
 *
 * Per instance by design. Keys carry versions (catalogVersion, minute buckets), so another
 * instance holding an older entry can never serve data of the wrong revision; Redis can
 * replace this behind the same port when cross-instance sharing becomes worth it.
 */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
    // In-flight computations started before the invalidation must not repopulate the cache.
    for (const key of this.inflight.keys()) if (key.startsWith(prefix)) this.inflight.delete(key);
  }

  async wrap<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = factory().then(
      (value) => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
          this.set(key, value, ttlMs);
        }
        return value;
      },
      (error: unknown) => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
        throw error;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.entries.size;
  }
}
