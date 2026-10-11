/**
 * In-process cache port (IMemoryCache-style). Values are cached per instance; correctness
 * never depends on it — keys embed versions (catalogVersion, minute buckets) so a stale entry
 * on another instance simply ages out.
 */
export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  deleteByPrefix(prefix: string): void;
  /** Returns the cached value or computes it once — concurrent callers share one computation. */
  wrap<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T>;
}
