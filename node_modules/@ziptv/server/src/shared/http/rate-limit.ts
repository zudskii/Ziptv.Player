import type { ApiErrorBody } from '@ziptv/contracts';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

interface LimitOptions {
  windowMs: number;
  limit: number;
  /** Key by authenticated user when available (falls back to the client IP). */
  perUser?: boolean;
}

/**
 * Fixed-window limiter with the API error shape.
 *
 * NOTE: the default store is in-memory, i.e. per instance. When running more than one
 * instance behind a load balancer, plug a shared store (e.g. `rate-limit-redis`) here.
 */
export function createRateLimiter({ windowMs, limit, perUser = false }: LimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req: Request) => (perUser && req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? 'unknown')),
    handler: (_req, res, _next, options) => {
      const body: ApiErrorBody = {
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
      };
      res.status(options.statusCode).json(body);
    },
  });
}
