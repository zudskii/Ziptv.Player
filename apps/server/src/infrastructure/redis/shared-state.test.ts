import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LeaseStore } from '../../application/ports/lease-store.js';
import { CoherentCache } from '../cache/coherent-cache.js';
import { MemoryCache } from '../cache/memory-cache.js';
import { MemoryLeaseStore } from '../cache/memory-lease-store.js';
import { createLogger } from '../logger.js';
import { createRedis, RedisInvalidationBus, RedisLeaseStore, RedisRateLimitStore, redisRateLimitStores } from './redis.js';

/** Shared state across instances. Redis cases run when TEST_REDIS_URL is set (CI provides it). */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const logger = createLogger({ log: { level: 'silent' }, env: 'test' });
const unique = () => `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function leaseContract(name: string, make: () => { store: LeaseStore; advance: (ms: number) => Promise<void> }) {
  describe(`${name} lease contract`, () => {
    it('admits up to `limit` holders, refreshes an existing holder, refuses the next one', async () => {
      const { store } = make();
      const key = unique();
      expect(await store.acquire(key, 'tv', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 1 });
      expect(await store.acquire(key, 'phone', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 2 });
      expect(await store.acquire(key, 'tv', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 2 });
      expect(await store.acquire(key, 'laptop', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: false, holders: 2 });
      expect((await store.holders(key)).sort()).toEqual(['phone', 'tv']);
      await store.release(key, 'phone');
      expect((await store.acquire(key, 'laptop', { limit: 2, ttlMs: 5_000 })).acquired).toBe(true);
    });

    it('expires holders that stop renewing; renew only works while held', async () => {
      const { store, advance } = make();
      const key = unique();
      await store.acquire(key, 'tv', { limit: 1, ttlMs: 300 });
      expect(await store.renew(key, 'tv', 300)).toBe(true);
      expect(await store.renew(key, 'other', 300)).toBe(false);
      await advance(450);
      expect(await store.holders(key)).toEqual([]);
      expect(await store.renew(key, 'tv', 300)).toBe(false);
      expect((await store.acquire(key, 'phone', { limit: 1, ttlMs: 300 })).acquired).toBe(true);
    });
  });
}

describe('RedisRateLimitStore without Redis', () => {
  it('keeps limiting (in memory) when Redis is unreachable at boot — no errors, no outage', async () => {
    const dead = createRedis('redis://127.0.0.1:1', 'test:', logger);
    const store = new RedisRateLimitStore(dead, 'boot', logger);
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('client')).totalHits).toBe(1);
    expect((await store.increment('client')).totalHits).toBe(2); // degraded: memory, immediately
    store.shutdown();
    dead.disconnect();
  });

  it('falls back during a Redis error and returns to Redis after a few seconds', async () => {
    let now = 1_000_000;
    let failing = false;
    let redisHits = 0;
    const fake = {
      ziptvRateIncrement: async () => {
        if (failing) throw new Error('connection lost');
        return [++redisHits, 60_000] as [number, number];
      },
    };
    const store = new RedisRateLimitStore(fake as never, 'flaky', logger, () => now);
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('c')).totalHits).toBe(1); // Redis
    failing = true;
    expect((await store.increment('c')).totalHits).toBe(1); // memory fallback, its own count
    failing = false;
    expect((await store.increment('c')).totalHits).toBe(2); // still degraded: no Redis round trip per request
    expect(redisHits).toBe(1);
    now += 6_000;
    expect((await store.increment('c')).totalHits).toBe(2); // back on Redis, whose count survived
    store.shutdown();
  });
});

leaseContract('MemoryLeaseStore', () => {
  let now = 1_000_000;
  return {
    store: new MemoryLeaseStore(() => now),
    advance: async (ms) => {
      now += ms;
    },
  };
});

describe.skipIf(!TEST_REDIS_URL)('Redis shared state', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = createRedis(TEST_REDIS_URL!, `${unique()}:`, logger);
  });
  afterAll(async () => {
    await redis?.quit();
  });

  leaseContract('RedisLeaseStore', () => ({ store: new RedisLeaseStore(redis), advance: (ms) => sleep(ms) }));

  it('rate limits count across instances', async () => {
    const name = unique();
    const instance = () => {
      const app = express();
      // Each "instance" has its own limiter and store objects, sharing only Redis.
      app.get('/', rateLimit({ windowMs: 60_000, limit: 3, store: redisRateLimitStores(redis, logger)(name), keyGenerator: () => 'client' }), (_req, res) => {
        res.status(204).end();
      });
      return app;
    };
    const [a, b] = [instance(), instance()];
    await request(a).get('/').expect(204);
    await request(b).get('/').expect(204);
    await request(a).get('/').expect(204);
    await request(b).get('/').expect(429);
  });

  it('cache invalidations reach every instance', async () => {
    const busA = new RedisInvalidationBus(redis, logger);
    const busB = new RedisInvalidationBus(redis, logger);
    const [a, b] = [new CoherentCache(new MemoryCache(), busA), new CoherentCache(new MemoryCache(), busB)];
    await sleep(100); // subscriptions established
    for (const cache of [a, b]) {
      cache.set('source:1:live', 'v1', 60_000);
      cache.set('grant:session:x', true, 60_000);
    }
    a.deleteByPrefix('source:1:');
    a.delete('grant:session:x');
    for (let i = 0; i < 50 && (b.get('source:1:live') !== undefined || b.get('grant:session:x') !== undefined); i++) await sleep(20);
    expect(b.get('source:1:live')).toBeUndefined();
    expect(b.get('grant:session:x')).toBeUndefined();
    await busA.close();
    await busB.close();
  });
});
