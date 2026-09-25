import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../shared/errors.js';
import { createRateLimiter } from '../../shared/http/rate-limit.js';
import { currentUser } from '../../shared/http/request-context.js';
import { parseInput } from '../../shared/http/validate.js';
import type { SessionService } from './session.service.js';

const CreateSessionBody = z
  .object({
    legacySecretId: z
      .string()
      .trim()
      .regex(/^id\d{1,20}$/, 'not a legacy secret id')
      .optional(),
  })
  .strict();

/** `Authorization: Bearer <token>` → `req.user`. */
export function requireSession(sessions: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw AppError.unauthorized();

    const user = await sessions.authenticate(token);
    if (!user) throw AppError.unauthorized('Session is unknown or expired. Create a new session.');
    req.user = user;
    next();
  };
}

export function createSessionRouter(sessions: SessionService, auth: RequestHandler): Router {
  const router = Router();
  // Creating identities is the one unauthenticated write — keep it tight per IP.
  const createLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 30 });

  router.post('/', createLimiter, async (req, res) => {
    const body = parseInput(CreateSessionBody, req.body ?? {}, 'Session request');
    const session = await sessions.createSession(body);
    res.status(201).json(session);
  });

  router.get('/me', auth, (req, res) => {
    res.json(sessions.toMe(currentUser(req)));
  });

  return router;
}
