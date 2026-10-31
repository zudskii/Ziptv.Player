/** A cache invalidation, broadcast so every instance drops the same entries. */
export type Invalidation = { type: 'key'; key: string } | { type: 'prefix'; prefix: string };

/**
 * Fan-out of cache invalidations between instances (Redis pub/sub). Delivery is best effort:
 * caches keep versioned keys and TTLs, so a missed message only means a stale entry ages out.
 */
export interface InvalidationBus {
  publish(message: Invalidation): void;
  subscribe(handler: (message: Invalidation) => void): void;
  close(): Promise<void>;
}
