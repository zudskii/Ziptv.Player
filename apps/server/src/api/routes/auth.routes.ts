import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { AccountService } from '../../application/identity/account.service.js';
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, normalizeEmail } from '../../domain/identity/credentials.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { currentUser, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from './schemas.js';

const Email = z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email('must be a valid email address'));
/** Shape only; the password policy (length, etc.) is a domain rule applied by the service. */
const Password = z.string().min(1, 'is required').max(MAX_PASSWORD_LENGTH, `must be at most ${MAX_PASSWORD_LENGTH} characters`);

const RegisterBody = z.object({ email: Email, password: Password }).strict();
const LoginBody = z.object({ email: Email, password: Password, mergeGuest: z.boolean().optional() }).strict();
const ChangePasswordBody = z.object({ currentPassword: Password, newPassword: Password }).strict();
const DeleteAccountBody = z.object({ password: Password }).strict();

/** The bucket of the account being attacked, whichever IP the guesses come from. */
const emailBucket = (req: { body?: unknown }): string | undefined => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email ? `email:${normalizeEmail(email).slice(0, MAX_EMAIL_LENGTH)}` : undefined;
};

/**
 * /auth: register, log in/out, devices, password, delete account.
 * (Guests are created by POST /sessions; this router is for email + password accounts.)
 */
export function createAuthRouter(deps: { accounts: AccountService; auth: RequestHandler; optionalAuth: RequestHandler }): Router {
  const { accounts, auth, optionalAuth } = deps;
  const router = Router();

  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 10 });
  // Password guessing is limited per IP *and* per targeted email; only failures count.
  const loginIpLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, limit: 20, skipSuccessful: true });
  const loginEmailLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessful: true, key: emailBucket });
  const sensitiveLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, limit: 10, perUser: true, skipSuccessful: true });

  const context = (req: Parameters<RequestHandler>[0]) => ({ current: req.user ?? null, userAgent: req.get('user-agent') ?? null });

  router.post('/register', registerLimiter, optionalAuth, async (req, res) => {
    const body = parseInput(RegisterBody, req.body, 'Registration');
    res.status(201).json(await accounts.register(body, context(req)));
  });

  router.post('/login', loginIpLimiter, loginEmailLimiter, optionalAuth, async (req, res) => {
    const body = parseInput(LoginBody, req.body, 'Login');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accounts.login(body, context(req)));
  });

  router.post('/logout', auth, async (req, res) => {
    await accounts.logout(currentUser(req));
    res.status(204).end();
  });

  router.get('/sessions', auth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await accounts.listSessions(currentUser(req)));
  });

  router.delete('/sessions/:sessionId', auth, async (req, res) => {
    const sessionId = parseInput(EntityId, routeParam(req, 'sessionId'), 'Session id');
    await accounts.revokeSession(currentUser(req), sessionId);
    res.status(204).end();
  });

  router.post('/password', auth, sensitiveLimiter, async (req, res) => {
    await accounts.changePassword(currentUser(req), parseInput(ChangePasswordBody, req.body, 'Password change'));
    res.status(204).end();
  });

  router.delete('/account', auth, sensitiveLimiter, async (req, res) => {
    await accounts.deleteAccount(currentUser(req), parseInput(DeleteAccountBody, req.body, 'Account deletion'));
    res.status(204).end();
  });

  return router;
}
