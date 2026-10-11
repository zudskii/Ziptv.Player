import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { SessionService } from '../../application/identity/session.service.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { currentUser } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const CreateSessionBody = z
  .object({
    legacySecretId: z
      .string()
      .trim()
      .regex(/^id\d{1,20}$/, 'not a legacy secret id')
      .optional(),
  })
  .strict();

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
