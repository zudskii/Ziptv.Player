import { MemoryStore, type ClientRateLimitInfo, type Options as RateLimitOptions, type Store } from 'express-rate-limit';
import { Redis } from 'ioredis';

import type { Invalidation, InvalidationBus } from '../../application/ports/invalidation-bus.js';
import type { LeaseStore } from '../../application/ports/lease-store.js';
import type { Logger } from '../../application/ports/logger.js';

/**
 * One command connection per process; pub/sub needs its own (a subscribed connection can do
 * nothing else). `keyPrefix` namespaces every key, so staging and production can share a Redis.
 * Commands time out after a second: callers fall back (rate limits) or fail fast instead of
 * hanging requests while Redis is unreachable.
 */
export function createRedis(url: string, keyPrefix: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    keyPrefix,
    maxRetriesPerRequest: 2,
    commandTimeout: 1_000,
    enableAutoPipelining: true,
  });
  redis.on('error', (error) => logger.warn({ err: error }, 'Redis connection error'));
  defineScripts(redis);
  return redis;
}

const RATE_INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

interface ScriptedRedis {
  ziptvRateIncrement(key: string, windowMs: string): Promise<[number, number]>;
  ziptvLeaseAcquire(key: string, holder: string, limit: string, ttlMs: string): Promise<[number, number]>;
  ziptvLeaseRenew(key: string, holder: string, ttlMs: string): Promise<number>;
  ziptvLeaseHolders(key: string): Promise<string[]>;
}

/** Scripts are sent once and then called by SHA (ioredis reloads them after a Redis restart). */
function defineScripts(redis: Redis): void {
  redis.defineCommand('ziptvRateIncrement', { numberOfKeys: 1, lua: RATE_INCREMENT });
  redis.defineCommand('ziptvLeaseAcquire', { numberOfKeys: 1, lua: ACQUIRE });
  redis.defineCommand('ziptvLeaseRenew', { numberOfKeys: 1, lua: RENEW });
  redis.defineCommand('ziptvLeaseHolders', { numberOfKeys: 1, lua: HOLDERS });
}

const scripted = (redis: Redis) => redis as unknown as ScriptedRedis;

/** How long the store keeps counting locally after a Redis error before trying Redis again. */
const DEGRADED_MS = 5_000;

/**
 * Fixed-window rate-limit store in Redis, shared by every instance.
 *
 * Never turns a Redis problem into an outage: when Redis is unreachable (at boot or later) the
 * limiter keeps counting in memory for a few seconds, then retries Redis. Limits stay enforced
 * (per instance) instead of failing every request or silently letting brute force through.
 */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  private degradedUntil = 0;

  constructor(
    private readonly redis: Redis,
    name: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.prefix = `rl:${name}:`;
  }

  init(options: RateLimitOptions): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (this.now() >= this.degradedUntil) {
      try {
        const [hits, ttl] = await scripted(this.redis).ziptvRateIncrement(this.prefix + key, String(this.windowMs));
        return { totalHits: hits, resetTime: new Date(this.now() + ttl) };
      } catch (error) {
        this.degrade(error);
      }
    }
    return this.fallback.increment(key);
  }

  async decrement(key: string): Promise<void> {
    if (this.now() < this.degradedUntil) return this.fallback.decrement(key);
    await this.redis.decr(this.prefix + key).catch((error: unknown) => this.degrade(error));
  }

  async resetKey(key: string): Promise<void> {
    this.fallback.resetKey(key);
    await this.redis.del(this.prefix + key).catch((error: unknown) => this.degrade(error));
  }

  shutdown(): void {
    this.fallback.shutdown();
  }

  private degrade(error: unknown): void {
    if (this.now() >= this.degradedUntil) this.logger.warn({ err: error, limiter: this.prefix }, 'Rate limiting falls back to per-instance memory (Redis unavailable)');
    this.degradedUntil = this.now() + DEGRADED_MS;
  }
}

/** express-rate-limit store per limiter, all counting in one Redis. */
export function redisRateLimitStores(redis: Redis, logger: Logger): (name: string) => Store {
  return (name) => new RedisRateLimitStore(redis, name, logger);
}

export class RedisInvalidationBus implements InvalidationBus {
  private readonly subscriber: Redis;
  private readonly channel: string;
  private readonly origin = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  private readonly handlers: ((message: Invalidation) => void)[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {
    // Channels are not covered by keyPrefix: namespace them explicitly.
    this.channel = `${redis.options.keyPrefix ?? ''}cache-invalidation`;
    this.subscriber = redis.duplicate();
    this.subscriber.on('error', (error) => logger.warn({ err: error }, 'Redis subscriber error'));
    void this.subscriber.subscribe(this.channel).catch((error: unknown) => logger.warn({ err: error }, 'Redis subscribe failed'));
    this.subscriber.on('message', (_channel: string, raw: string) => {
      let parsed: { origin: string; message: Invalidation };
      try {
        parsed = JSON.parse(raw) as { origin: string; message: Invalidation };
      } catch {
        return;
      }
      if (parsed.origin === this.origin) return; // already applied locally
      for (const handler of this.handlers) handler(parsed.message);
    });
  }

  publish(message: Invalidation): void {
    this.redis.publish(this.channel, JSON.stringify({ origin: this.origin, message })).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Cache invalidation could not be published');
    });
  }

  subscribe(handler: (message: Invalidation) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.subscriber.disconnect();
  }
}

/*
 * Leases as a sorted set per key: member = holder, score = expiry in ms (Redis server clock, so
 * instances with skewed clocks agree). Each script first drops expired holders.
 */
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if held or count < limit then
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
  local maxScore = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')[2]
  redis.call('PEXPIREAT', KEYS[1], maxScore)
  return {1, redis.call('ZCARD', KEYS[1])}
end
return {0, count}
`;

const RENEW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
local maxScore = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')[2]
redis.call('PEXPIREAT', KEYS[1], maxScore)
return 1
`;

const HOLDERS = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], 0, -1)
`;

export class RedisLeaseStore implements LeaseStore {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, holder: string, options: { limit: number; ttlMs: number }): Promise<{ acquired: boolean; holders: number }> {
    const [acquired, holders] = await scripted(this.redis).ziptvLeaseAcquire(this.key(key), holder, String(options.limit), String(Math.ceil(options.ttlMs)));
    return { acquired: acquired === 1, holders };
  }

  async renew(key: string, holder: string, ttlMs: number): Promise<boolean> {
    return (await scripted(this.redis).ziptvLeaseRenew(this.key(key), holder, String(Math.ceil(ttlMs)))) === 1;
  }

  async release(key: string, holder: string): Promise<void> {
    await this.redis.zrem(this.key(key), holder);
  }

  async holders(key: string): Promise<string[]> {
    return scripted(this.redis).ziptvLeaseHolders(this.key(key));
  }

  private key(key: string): string {
    return `lease:${key}`;
  }
}
