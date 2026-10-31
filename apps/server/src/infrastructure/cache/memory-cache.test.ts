import { describe, expect, it } from 'vitest';

import { MemoryCache } from './memory-cache.js';

describe('MemoryCache', () => {
  it('expires entries, evicts least recently used, invalidates by prefix', () => {
    let now = 0;
    const cache = new MemoryCache(2, () => now);
    cache.set('a', 1, 100);
    cache.set('b', 2, 100);
    expect(cache.get('a')).toBe(1); // a is now most recent
    cache.set('c', 3, 100); // evicts b
    expect(cache.get('b')).toBeUndefined();
    now = 150;
    expect(cache.get('a')).toBeUndefined();

    cache.set('source:1:x', 1, 1000);
    cache.set('source:2:x', 2, 1000);
    cache.deleteByPrefix('source:1:');
    expect(cache.get('source:1:x')).toBeUndefined();
    expect(cache.get('source:2:x')).toBe(2);
  });

  it('coalesces concurrent misses into one computation and does not cache failures', async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls;
    };
    const results = await Promise.all([cache.wrap('k', 1000, factory), cache.wrap('k', 1000, factory), cache.wrap('k', 1000, factory)]);
    expect(results).toEqual([1, 1, 1]);
    expect(calls).toBe(1);

    await expect(cache.wrap('f', 1000, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cache.wrap('f', 1000, async () => 'ok')).toBe('ok');
  });

  it('does not let an invalidated in-flight computation repopulate the cache', async () => {
    const cache = new MemoryCache();
    let release: (value: string) => void = () => undefined;
    const pending = cache.wrap('source:1:list', 1000, () => new Promise<string>((resolve) => (release = resolve)));
    cache.deleteByPrefix('source:1:');
    release('stale');
    await pending;
    expect(cache.get('source:1:list')).toBeUndefined();
  });

  it('delete() also drops an in-flight computation (a revoked grant must not be re-cached as active)', async () => {
    const cache = new MemoryCache();
    let release: (value: boolean) => void = () => undefined;
    const pending = cache.wrap('grant:session:1', 1000, () => new Promise<boolean>((resolve) => (release = resolve)));
    cache.delete('grant:session:1');
    release(true);
    await pending;
    expect(cache.get('grant:session:1')).toBeUndefined();
  });
});
