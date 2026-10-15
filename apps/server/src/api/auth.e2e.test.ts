import type { AuthSessionDto, MeDto, SessionDto, SessionInfoDto, SourceDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, TEST_DATABASE_URL, type TestApp } from '../test/harness.js';

const PLAYLIST = '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://example.com/1.m3u8\n#EXTINF:-1,Two\nhttp://example.com/2.m3u8\n';
const PASSWORD = 'correct horse battery';

let clientIp = 0;
/** A different client address per call (the apps trust X-Forwarded-For), so per-IP limits do not couple unrelated tests. */
const ip = () => `10.${(++clientIp >> 8) & 255}.${clientIp & 255}.7`;

describe.skipIf(!TEST_DATABASE_URL)('Accounts end-to-end', () => {
  let t: TestApp;
  let counter = 0;

  beforeAll(async () => {
    t = await startTestApp({ TRUST_PROXY: '1' });
  });
  afterAll(async () => t.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const nextEmail = () => `user${++counter}@example.com`;

  async function guest(app: TestApp = t): Promise<SessionDto> {
    return (await request(app.app).post('/api/v1/sessions').set('X-Forwarded-For', ip()).send({}).expect(201)).body as SessionDto;
  }
  async function register(email = nextEmail(), token?: string, app: TestApp = t): Promise<AuthSessionDto & { email: string }> {
    const req = request(app.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip());
    const res = await (token ? req.set(bearer(token)) : req).send({ email, password: PASSWORD }).expect(201);
    return { ...(res.body as AuthSessionDto), email };
  }
  async function login(email: string, token?: string, extra: Record<string, unknown> = {}, app: TestApp = t): Promise<AuthSessionDto> {
    const req = request(app.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip());
    return (await (token ? req.set(bearer(token)) : req).send({ email, password: PASSWORD, ...extra }).expect(200)).body as AuthSessionDto;
  }
  const me = (token: string, app: TestApp = t) => request(app.app).get('/api/v1/sessions/me').set(bearer(token));
  async function addSource(token: string, app: TestApp = t): Promise<SourceDto> {
    return (await request(app.app).post('/api/v1/sources/upload').set(bearer(token)).attach('file', Buffer.from(PLAYLIST), 'list.m3u').expect(201)).body as SourceDto;
  }
  const sourceIds = async (token: string) => ((await request(t.app).get('/api/v1/sources').set(bearer(token)).expect(200)).body as SourceDto[]).map((s) => s.id);

  describe('registration', () => {
    it('creates an account with its own expiring session', async () => {
      const email = nextEmail();
      const account = await register(email);
      expect(account.user).toMatchObject({ email, isGuest: false, role: 'user' });
      expect(account.expiresAt).not.toBeNull();
      expect(JSON.stringify(account)).not.toContain(PASSWORD);

      const profile = (await me(account.token).expect(200)).body as MeDto;
      expect(profile).toMatchObject({ userId: account.user.userId, email, isGuest: false });
    });

    it('turns a guest into the account: same id, sources kept, guest token retired', async () => {
      const g = await guest();
      expect(((await me(g.token).expect(200)).body as MeDto)).toMatchObject({ isGuest: true, email: null });
      const source = await addSource(g.token);

      const account = await register(nextEmail(), g.token);
      expect(account.user.userId).toBe(g.userId);
      expect(await sourceIds(account.token)).toEqual([source.id]);
      await me(g.token).expect(401); // rotated: the old token must not outlive the privilege change
    });

    it('normalises the email and refuses duplicates regardless of case', async () => {
      const account = await register('Mixed.Case@Example.COM');
      expect(account.user.email).toBe('mixed.case@example.com');
      await login('  MIXED.case@example.com ');
      const duplicate = await request(t.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send({ email: 'mixed.CASE@example.com', password: PASSWORD }).expect(409);
      expect(duplicate.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('rejects bad input with a clear message', async () => {
      const post = (body: unknown) => request(t.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send(body as object);
      expect((await post({ email: nextEmail(), password: 'short' }).expect(400)).body.error.message).toMatch(/at least 8/);
      expect((await post({ email: 'not-an-email', password: PASSWORD }).expect(400)).body.error.message).toMatch(/email/i);
      expect((await post({ email: nextEmail(), password: PASSWORD, role: 'admin' }).expect(400)).body.error.code).toBe('VALIDATION_ERROR'); // no mass assignment
      await post({ email: nextEmail() }).expect(400);
    });

    it('does not touch the signed-in account when an account registers another', async () => {
      const first = await register();
      const second = await register(nextEmail(), first.token);
      expect(second.user.userId).not.toBe(first.user.userId);
      await me(first.token).expect(200);
    });
  });

  describe('login and sessions', () => {
    it('gives the same answer for a wrong password and an unknown email', async () => {
      const account = await register();
      const wrong = await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: account.email, password: 'wrong password!' }).expect(401);
      const unknown = await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: 'nobody@example.com', password: PASSWORD }).expect(401);
      expect(wrong.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
      expect(unknown.body.error).toEqual({ ...wrong.body.error, requestId: unknown.body.error.requestId });
    });

    it('signs in on several devices and signs one out without affecting the others', async () => {
      const first = await register();
      const phone = await login(first.email);
      const laptop = await login(first.email);

      const devices = (await request(t.app).get('/api/v1/auth/sessions').set(bearer(phone.token)).expect(200)).body as SessionInfoDto[];
      expect(devices).toHaveLength(3);
      expect(devices.filter((d) => d.current)).toHaveLength(1);

      await request(t.app).post('/api/v1/auth/logout').set(bearer(phone.token)).expect(204);
      await me(phone.token).expect(401);
      await me(laptop.token).expect(200);
      await me(first.token).expect(200);

      // Revoke another device remotely.
      const list = (await request(t.app).get('/api/v1/auth/sessions').set(bearer(laptop.token)).expect(200)).body as SessionInfoDto[];
      const other = list.find((d) => !d.current)!;
      await request(t.app).delete(`/api/v1/auth/sessions/${other.id}`).set(bearer(laptop.token)).expect(204);
      await request(t.app).delete(`/api/v1/auth/sessions/${other.id}`).set(bearer(laptop.token)).expect(404);
      await request(t.app).delete('/api/v1/auth/sessions/not-an-id').set(bearer(laptop.token)).expect(400);
    });

    it('cannot revoke somebody else’s device', async () => {
      const mine = await register();
      const theirs = await register();
      const theirDevice = ((await request(t.app).get('/api/v1/auth/sessions').set(bearer(theirs.token)).expect(200)).body as SessionInfoDto[])[0]!;
      await request(t.app).delete(`/api/v1/auth/sessions/${theirDevice.id}`).set(bearer(mine.token)).expect(404);
      await me(theirs.token).expect(200);
    });

    it('limits password guessing per account and still lets other accounts in', async () => {
      const victim = await register();
      // The guesses come from ten different addresses, so only the per-account limit can stop them.
      for (let attempt = 0; attempt < 10; attempt++) {
        await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: victim.email, password: `guess number ${attempt}` }).expect(401);
      }
      // Even the right password is refused for a while: that is what stops the guessing.
      const blocked = await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: victim.email, password: PASSWORD }).expect(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      const bystander = await register();
      await login(bystander.email);
    });
  });

  describe('password and deletion', () => {
    it('changes the password, signs the other devices out and keeps this one', async () => {
      const a = await register();
      const b = await login(a.email);
      const change = (token: string, body: object) => request(t.app).post('/api/v1/auth/password').set(bearer(token)).send(body);

      // Wrong current password: 403, not 401 — a 401 would make the web client start a new guest session.
      const wrong = await change(b.token, { currentPassword: 'not my password', newPassword: 'another long password' }).expect(403);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      await change(b.token, { currentPassword: PASSWORD, newPassword: 'short' }).expect(400);

      await change(b.token, { currentPassword: PASSWORD, newPassword: 'another long password' }).expect(204);
      await me(b.token).expect(200);
      await me(a.token).expect(401);
      await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: a.email, password: PASSWORD }).expect(401);
      await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: a.email, password: 'another long password' }).expect(200);
    });

    it('is not available to a guest', async () => {
      const g = await guest();
      const res = await request(t.app).post('/api/v1/auth/password').set(bearer(g.token)).send({ currentPassword: 'whatever1', newPassword: 'whatever2' }).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      await request(t.app).delete('/api/v1/auth/account').set(bearer(g.token)).send({ password: 'whatever1' }).expect(403);
    });

    it('deletes the account and everything it owns after confirming the password', async () => {
      const a = await register();
      await addSource(a.token);
      await request(t.app).delete('/api/v1/auth/account').set(bearer(a.token)).send({ password: 'not my password' }).expect(403);
      await me(a.token).expect(200);

      await request(t.app).delete('/api/v1/auth/account').set(bearer(a.token)).send({ password: PASSWORD }).expect(204);
      await me(a.token).expect(401);
      await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: a.email, password: PASSWORD }).expect(401);
      // The address is free again.
      await register(a.email);
    });

    it('requires a session for everything except register and login', async () => {
      await request(t.app).post('/api/v1/auth/logout').expect(401);
      await request(t.app).get('/api/v1/auth/sessions').expect(401);
      await request(t.app).post('/api/v1/auth/password').send({}).expect(401);
      await request(t.app).delete('/api/v1/auth/account').send({}).expect(401);
    });
  });

  describe('logging in from a device that already has guest data', () => {
    it('keeps the guest data apart unless asked to merge', async () => {
      const account = await register();
      const accountSource = await addSource(account.token);
      const g = await guest();
      await addSource(g.token);

      const plain = await login(account.email, g.token);
      expect(await sourceIds(plain.token)).toEqual([accountSource.id]);
      await me(g.token).expect(200); // the guest identity is still there, untouched
    });

    it('merges the guest’s sources into the account when asked, and retires the guest', async () => {
      const account = await register();
      const accountSource = await addSource(account.token);
      const g = await guest();
      const guestSource = await addSource(g.token);

      const merged = await login(account.email, g.token, { mergeGuest: true });
      expect((await sourceIds(merged.token)).sort()).toEqual([accountSource.id, guestSource.id].sort());
      await me(g.token).expect(401);
    });

    it('refuses a merge that would exceed the source limit and changes nothing', async () => {
      const tight = await startTestApp({ MAX_SOURCES_PER_USER: '1', TRUST_PROXY: '1' });
      try {
        const registered = await register(nextEmail(), undefined, tight);
        await addSource(registered.token, tight);
        const g = await guest(tight);
        await addSource(g.token, tight);

        const res = await request(tight.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).set(bearer(g.token)).send({ email: registered.email, password: PASSWORD, mergeGuest: true }).expect(409);
        expect(res.body.error.code).toBe('SOURCE_LIMIT_REACHED');
        await me(g.token, tight).expect(200);
        expect((await request(tight.app).get('/api/v1/sources').set(bearer(g.token)).expect(200)).body).toHaveLength(1);
      } finally {
        await tight.close();
      }
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('Session lifetime', () => {
  const DAY = 24 * 3600_000;
  let now = Date.parse('2026-01-01T00:00:00Z');
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ TRUST_PROXY: '1' }, { clock: { now: () => new Date(now) } });
  });
  afterAll(async () => t.close());

  const advance = (days: number) => {
    now += days * DAY;
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const status = async (token: string) => (await request(t.app).get('/api/v1/sessions/me').set(bearer(token))).status;
  // Activity is recorded after the response; give it a moment.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  it('expires an account session after 90 idle days, but not while it is in use', async () => {
    const account = (await request(t.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send({ email: 'ttl@example.com', password: PASSWORD }).expect(201)).body as AuthSessionDto;
    const idle = (await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).send({ email: 'ttl@example.com', password: PASSWORD }).expect(200)).body as AuthSessionDto;

    for (let i = 0; i < 3; i++) {
      advance(60);
      expect(await status(account.token)).toBe(200); // used every 60 days → slides forward
      await settle();
    }
    expect(await status(idle.token)).toBe(401); // 180 idle days
    expect(await status(account.token)).toBe(200);

    advance(91);
    expect(await status(account.token)).toBe(401);
  });

  it('never expires a guest session', async () => {
    const g = (await request(t.app).post('/api/v1/sessions').set('X-Forwarded-For', ip()).send({}).expect(201)).body as SessionDto;
    advance(2000);
    expect(await status(g.token)).toBe(200);
  });
});
