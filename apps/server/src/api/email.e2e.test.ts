import type { AuthFeaturesDto, AuthSessionDto, MeDto, SessionDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../application/ports/clock.js';
import { CapturingMailer } from '../test/capture-mailer.js';
import { startTestApp, TEST_DATABASE_URL, type TestApp } from '../test/harness.js';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a completely new passphrase';
const PUBLIC_URL = 'https://tv.example.test';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

let counter = 0;
const ip = () => `10.5.${(++counter >> 8) & 255}.${counter & 255}`;
const nextEmail = () => `mail${++counter}@example.com`;

describe.skipIf(!TEST_DATABASE_URL)('Email links end-to-end', () => {
  const mailer = new CapturingMailer();
  const clock = { time: Date.parse('2026-03-01T10:00:00Z') };
  const fakeClock: Clock = { now: () => new Date(clock.time) };
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ TRUST_PROXY: '1', PUBLIC_URL }, { mailer, clock: fakeClock });
  });
  afterAll(async () => t.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body: object = {}, headers: Record<string, string> = {}) => request(t.app).post(`/api/v1${path}`).set('X-Forwarded-For', ip()).set(headers).send(body);
  const me = (token: string) => request(t.app).get('/api/v1/sessions/me').set(bearer(token));
  const profile = async (token: string) => (await me(token).expect(200)).body as MeDto;
  /** A registered account; its confirmation email is waited for and returned. */
  async function register(email = nextEmail()) {
    const before = mailer.sent.length;
    const session = (await post('/auth/register', { email, password: PASSWORD }).expect(201)).body as AuthSessionDto;
    const [verification] = (await mailer.waitFor(before + 1)).slice(before);
    return { email, token: session.token, verification: verification! };
  }
  const login = (email: string, password = PASSWORD) => post('/auth/login', { email, password });

  // --- what the server can do -----------------------------------------------------------------

  it('reports that email works when a transport and a public address are configured', async () => {
    expect(((await request(t.app).get('/api/v1/auth/features').expect(200)).body as AuthFeaturesDto)).toEqual({ passwordReset: true, emailVerification: true });
  });

  it('turns the email features off — and says so — without a transport or without a public address', async () => {
    for (const [env, mail] of [[{ TRUST_PROXY: '1', PUBLIC_URL }, null], [{ TRUST_PROXY: '1' }, new CapturingMailer()]] as const) {
      const bare = await startTestApp(env, { mailer: mail });
      try {
        expect(((await request(bare.app).get('/api/v1/auth/features').expect(200)).body as AuthFeaturesDto)).toEqual({ passwordReset: false, emailVerification: false });
        const forgot = await request(bare.app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', ip()).send({ email: 'a@example.com' }).expect(501);
        expect(forgot.body.error.code).toBe('FEATURE_DISABLED');
        await request(bare.app).post('/api/v1/auth/reset-password').set('X-Forwarded-For', ip()).send({ token: 'x'.repeat(43), password: NEW_PASSWORD }).expect(501);
        // Registering still works; nothing is sent.
        await request(bare.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send({ email: nextEmail(), password: PASSWORD }).expect(201);
        if (mail) {
          await mail.settle();
          expect(mail.sent).toEqual([]);
        }
      } finally {
        await bare.close();
      }
    }
  });

  // --- confirming the address -----------------------------------------------------------------

  it('sends a confirmation link on registration; opening it confirms the address, once', async () => {
    const { token, email, verification } = await register();
    expect(verification.to).toBe(email);
    expect(verification.subject).toMatch(/Confirm/);
    const link = CapturingMailer.linkIn(verification);
    expect(link.startsWith(`${PUBLIC_URL}/verify-email#token=`)).toBe(true);
    const secret = CapturingMailer.tokenIn(verification);
    expect(secret).toMatch(TOKEN);
    expect((await profile(token)).emailVerified).toBe(false);

    await post('/auth/verify-email', { token: secret }).expect(204); // opened in a browser that may not even be signed in
    expect((await profile(token)).emailVerified).toBe(true);
    expect((await post('/auth/verify-email', { token: secret }).expect(400)).body.error.code).toBe('INVALID_TOKEN'); // single use
  });

  it('answers every bad link the same way: malformed, unknown, wrong kind', async () => {
    await register();
    const second = await register(); // waits for its confirmation email, so the count below is stable
    const before = mailer.sent.length;
    await post('/auth/forgot-password', { email: second.email }).expect(202);
    const resetSecret = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);
    const answers = [];
    for (const token of ['short', 'x'.repeat(43), 'x'.repeat(200), resetSecret]) {
      const res = await post('/auth/verify-email', { token });
      answers.push([res.status, res.body.error.code, res.body.error.message]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1); // a reset link cannot confirm an address either
    expect(answers[0]).toEqual([400, 'INVALID_TOKEN', 'This link is invalid or has expired. Request a new one.']);
    expect((await post('/auth/verify-email', { token: 'x'.repeat(300) })).status).toBe(400); // absurdly long: refused by the request-shape check
  });

  it('lets an account ask for a new confirmation link; the previous one stops working', async () => {
    const { token, verification } = await register();
    const first = CapturingMailer.tokenIn(verification);
    const before = mailer.sent.length;
    await request(t.app).post('/api/v1/auth/send-verification').set(bearer(token)).set('X-Forwarded-For', ip()).send({}).expect(202);
    const second = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);
    expect(second).not.toBe(first);
    await post('/auth/verify-email', { token: first }).expect(400);
    await post('/auth/verify-email', { token: second }).expect(204);

    // Already confirmed: nothing more is sent.
    await request(t.app).post('/api/v1/auth/send-verification').set(bearer(token)).set('X-Forwarded-For', ip()).send({}).expect(202);
    await mailer.settle();
    expect(mailer.sent.length).toBe(before + 1);
  });

  it('does not offer a guest an address to confirm, and limits how often a link can be requested', async () => {
    const guest = ((await post('/sessions').expect(201)).body as SessionDto).token;
    await request(t.app).post('/api/v1/auth/send-verification').set(bearer(guest)).set('X-Forwarded-For', ip()).send({}).expect(403);

    const { token } = await register();
    for (let i = 0; i < 3; i++) await request(t.app).post('/api/v1/auth/send-verification').set(bearer(token)).set('X-Forwarded-For', ip()).send({}).expect(202);
    const limited = await request(t.app).post('/api/v1/auth/send-verification').set(bearer(token)).set('X-Forwarded-For', ip()).send({}).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  // --- forgotten password ---------------------------------------------------------------------

  it('answers a forgotten-password request identically for registered and unknown addresses, and mails only the former', async () => {
    const { email } = await register();
    const before = mailer.sent.length;
    const known = await post('/auth/forgot-password', { email });
    const unknown = await post('/auth/forgot-password', { email: 'nobody-here@example.com' });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(known.body).toEqual(unknown.body);
    expect(known.headers['content-length']).toBe(unknown.headers['content-length']);

    const sent = (await mailer.waitFor(before + 1)).slice(before);
    await mailer.settle();
    expect(mailer.sent.slice(before)).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject).toMatch(/Reset/);
    expect(CapturingMailer.linkIn(sent[0]!).startsWith(`${PUBLIC_URL}/reset-password#token=`)).toBe(true);
  });

  it('builds links from the configured address, never from the request (a forged Host cannot redirect the email)', async () => {
    const { email } = await register();
    const before = mailer.sent.length;
    await post('/auth/forgot-password', { email }, { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', Origin: 'https://evil.example', Referer: 'https://evil.example/' }).expect(202);
    const link = CapturingMailer.linkIn((await mailer.waitFor(before + 1))[before]!);
    expect(link.startsWith(`${PUBLIC_URL}/`)).toBe(true);
    expect(link).not.toContain('evil');
  });

  it('does not wait for the mail server, and a broken one never shows in the answer', async () => {
    const { email } = await register();
    let release!: () => void;
    mailer.gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const res = await post('/auth/forgot-password', { email }).expect(202); // returned although the "mail server" is still busy
      expect(res.body).toEqual({});
    } finally {
      release();
      mailer.gate = null;
    }
    mailer.failWith = new Error('connection refused');
    try {
      await post('/auth/forgot-password', { email }).expect(202);
      await post('/auth/register', { email: nextEmail(), password: PASSWORD }).expect(201); // registering is not blocked by a mail problem either
      await mailer.settle();
    } finally {
      mailer.failWith = null;
    }
  });

  it('resets the password: the new one works, the old one does not, every device is signed out, the link works once', async () => {
    const { email, token } = await register();
    const other = ((await login(email).expect(200)).body as AuthSessionDto).token;
    const before = mailer.sent.length;
    await post('/auth/forgot-password', { email }).expect(202);
    const secret = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);

    await post('/auth/reset-password', { token: secret, password: NEW_PASSWORD }).expect(204);
    await login(email, PASSWORD).expect(401);
    await login(email, NEW_PASSWORD).expect(200);
    await me(token).expect(401);
    await me(other).expect(401);
    expect((await post('/auth/reset-password', { token: secret, password: 'yet another passphrase' }).expect(400)).body.error.code).toBe('INVALID_TOKEN');
    const again = (await login(email, NEW_PASSWORD).expect(200)).body as AuthSessionDto;
    expect((await profile(again.token)).emailVerified).toBe(true); // reading the email proved the address
  });

  it('keeps the link alive when the new password is refused, so it can be corrected', async () => {
    const { email } = await register();
    const before = mailer.sent.length;
    await post('/auth/forgot-password', { email }).expect(202);
    const secret = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);

    const weak = await post('/auth/reset-password', { token: secret, password: 'short' }).expect(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect((await post('/auth/reset-password', { token: secret, password: email }).expect(400)).body.error.message).toMatch(/same as your email/);
    await post('/auth/reset-password', { token: secret, password: NEW_PASSWORD }).expect(204);
  });

  it('expires a reset link after an hour and replaces older links when a new one is requested', async () => {
    const { email } = await register();
    let before = mailer.sent.length;
    await post('/auth/forgot-password', { email }).expect(202);
    const old = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);
    before = mailer.sent.length;
    await post('/auth/forgot-password', { email }).expect(202);
    const fresh = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);
    await post('/auth/reset-password', { token: old, password: NEW_PASSWORD }).expect(400); // replaced by the newer link

    clock.time += 61 * 60_000;
    await post('/auth/reset-password', { token: fresh, password: NEW_PASSWORD }).expect(400); // expired
    clock.time -= 61 * 60_000;
    await post('/auth/reset-password', { token: fresh, password: NEW_PASSWORD }).expect(204);
  });

  it('lets only one of two simultaneous uses of the same link succeed', async () => {
    const { email } = await register();
    const before = mailer.sent.length;
    await post('/auth/forgot-password', { email }).expect(202);
    const secret = CapturingMailer.tokenIn((await mailer.waitFor(before + 1))[before]!);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/auth/reset-password', { token: secret, password: `${NEW_PASSWORD} ${i}` })));
    expect(results.filter((res) => res.status === 204)).toHaveLength(1);
    expect(results.filter((res) => res.status === 400)).toHaveLength(5);
  });

  it('limits requests per address, whichever computers they come from, and leaves other addresses alone', async () => {
    const { email } = await register();
    for (let i = 0; i < 3; i++) await post('/auth/forgot-password', { email }).expect(202);
    expect((await post('/auth/forgot-password', { email }).expect(429)).body.error.code).toBe('RATE_LIMITED');
    const unknown = 'unknown-address@example.com'; // limited the same way: the limit says nothing about who is registered
    for (let i = 0; i < 3; i++) await post('/auth/forgot-password', { email: unknown }).expect(202);
    await post('/auth/forgot-password', { email: unknown }).expect(429);
    await post('/auth/forgot-password', { email: nextEmail() }).expect(202);
  });

  // --- what is stored -------------------------------------------------------------------------

  it('stores only a hash of each token, pinned to the address it was sent to', async () => {
    const { email, verification } = await register();
    const secret = CapturingMailer.tokenIn(verification);
    const rows = await t.db.selectFrom('email_tokens').selectAll().where('email', '=', email).execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.token_hash).not.toContain(secret);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('removes expired tokens when the periodic cleanup runs', async () => {
    const { email } = await register();
    clock.time += 48 * 3_600_000;
    expect(await t.container.emailFlow.purgeExpired()).toBeGreaterThan(0);
    expect(await t.db.selectFrom('email_tokens').select('id').where('email', '=', email).execute()).toEqual([]);
  });
});
