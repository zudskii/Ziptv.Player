import type { ApiErrorBody } from '@ziptv/contracts';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

interface LimitOptions {
  windowMs: number;
  limit: number;
  /** Key by authenticated user when available (falls back to the client IP). */
  perUser?: boolean;
  /** Custom bucket (e.g. the email being attacked); returning undefined falls back to user/IP. */
  key?: (req: Request) => string | undefined;
  /** Count only failed (4xx/5xx) responses: a legitimate login must not use up the budget. */
  skipSuccessful?: boolean;
}

/**
 * Fixed-window limiter with the API error shape.
 *
 * NOTE: the default store is in-memory, i.e. per instance. When running more than one
 * instance behind a load balancer, plug a shared store (e.g. `rate-limit-redis`) here.
 */
export function createRateLimiter({ windowMs, limit, perUser = false, key, skipSuccessful = false }: LimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: skipSuccessful,
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
}
