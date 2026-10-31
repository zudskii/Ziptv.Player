/**
 * Expiring, counted leases shared by every instance: "at most `limit` holders of `key`, each
 * until it renews or its TTL runs out". Used for concurrent-stream limits (one holder per
 * playing device) and singleton work. Holders that crash simply expire.
 */
export interface LeaseStore {
  /** Takes (or refreshes) `holder`'s lease when it already holds one or fewer than `limit` do. */
  acquire(key: string, holder: string, options: { limit: number; ttlMs: number }): Promise<{ acquired: boolean; holders: number }>;
  /** Extends an existing lease; false when it expired or was never held (the holder must re-acquire). */
  renew(key: string, holder: string, ttlMs: number): Promise<boolean>;
  release(key: string, holder: string): Promise<void>;
  /** Current, unexpired holders. */
  holders(key: string): Promise<string[]>;
}
