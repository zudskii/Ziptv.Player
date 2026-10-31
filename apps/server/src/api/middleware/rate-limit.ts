import type { ApiErrorBody } from '@ziptv/contracts';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';

export interface LimitOptions {
  /** Unique, stable name: the bucket namespace in a shared store (e.g. `auth:login-ip`). */
  name: string;
  windowMs: number;
  limit: number;
  /** Key by authenticated user when available (falls back to the client IP). */
  perUser?: boolean;
  /** Custom bucket (e.g. the email being attacked); returning undefined falls back to user/IP. */
  key?: (req: Request) => string | undefined;
  /** Count only failed (4xx/5xx) responses: a legitimate login must not use up the budget. */
  skipSuccessful?: boolean;
}

export type RateLimiterFactory = (options: LimitOptions) => RequestHandler;

/** A store per limiter name, shared by every instance (Redis). Absent → in-memory per instance. */
export type RateLimitStoreFactory = (name: string) => Store;

/**
 * Fixed-window limiters with the API error shape.
 *
 * Without a shared store each instance counts on its own, so N replicas allow N× the budget —
 * acceptable for one instance, wrong behind a load balancer (login brute force, abuse). With
 * `REDIS_URL` set, every limiter counts in Redis.
 */
export function rateLimiterFactory(stores: RateLimitStoreFactory | null = null): RateLimiterFactory {
  const names = new Set<string>();
  return ({ name, windowMs, limit, perUser = false, key, skipSuccessful = false }) => {
    // Two limiters sharing a bucket would silently halve each other's budget.
    if (names.has(name)) throw new Error(`Duplicate rate limiter name "${name}"`);
    names.add(name);
    return rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skipSuccessfulRequests: skipSuccessful,
      ...(stores ? { store: stores(name) } : {}),
      keyGenerator: (req: Request) => {
        const custom = key?.(req);
        if (custom) return `key:${custom}`;
        return perUser && req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? 'unknown');
      },
      handler: (_req, res, _next, options) => {
        const body: ApiErrorBody = {
          error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
        };
        res.status(options.statusCode).json(body);
      },
    });
  };
}
