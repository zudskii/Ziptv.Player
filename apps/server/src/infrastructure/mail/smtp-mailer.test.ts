import type { AddressInfo } from 'node:net';

import { simpleParser, type ParsedMail } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';

import { passwordResetMail } from '../../application/identity/mail-templates.js';
import { SmtpMailer } from './smtp-mailer.js';

interface Received {
  mail: ParsedMail;
  user: string | undefined;
  from: string;
  to: string[];
}

/** A real SMTP server on a local port that requires a login and keeps what it receives. */
async function startSmtp(): Promise<{ port: number; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (auth.username === 'mailer' && auth.password === 'p@ss:word/with+symbols') callback(null, { user: auth.username });
      else callback(new Error('Invalid login'));
    },
    onData(stream, session, callback) {
      simpleParser(stream)
        .then((mail) => {
          received.push({ mail, user: session.user as string | undefined, from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address) });
          callback();
        })
        .catch(callback);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.server.address() as AddressInfo).port, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('SmtpMailer against a real SMTP server', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  it('delivers a multipart message with both text and HTML, to the right address, after logging in', async () => {
    const smtp = await startSmtp();
    stop = smtp.close;
    // Credentials with characters that must be URL-encoded in the connection string.
    const mailer = new SmtpMailer(`smtp://mailer:${encodeURIComponent('p@ss:word/with+symbols')}@127.0.0.1:${smtp.port}`, 'ZIPTV <no-reply@example.com>');
    const link = 'https://tv.example.com/reset-password#token=abc';
    await mailer.send({ to: 'giorgi@example.com', ...passwordResetMail(link, 60) });

    expect(smtp.received).toHaveLength(1);
    const { mail, user, from, to } = smtp.received[0]!;
    expect(user).toBe('mailer');
    expect(from).toBe('no-reply@example.com');
    expect(to).toEqual(['giorgi@example.com']);
    expect(mail.subject).toBe('Reset your ZIPTV password');
    expect(mail.from?.value).toEqual([{ name: 'ZIPTV', address: 'no-reply@example.com' }]);
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
  });

  it('carries non-Latin subjects and names intact', async () => {
    const smtp = await startSmtp();
    stop = smtp.close;
    const mailer = new SmtpMailer(`smtp://mailer:${encodeURIComponent('p@ss:word/with+symbols')}@127.0.0.1:${smtp.port}`, 'ZIPTV <no-reply@example.com>');
    await mailer.send({ to: 'გიორგი@example.com'.replace('გიორგი', 'giorgi'), subject: 'პაროლის აღდგენა', text: 'გამარჯობა', html: '<p>გამარჯობა</p>' });
    expect(smtp.received[0]!.mail.subject).toBe('პაროლის აღდგენა');
    expect(smtp.received[0]!.mail.text?.trim()).toBe('გამარჯობა');
  });

  it('fails loudly when the credentials are wrong, so the caller can log it', async () => {
    const smtp = await startSmtp();
    stop = smtp.close;
    const mailer = new SmtpMailer(`smtp://mailer:wrong@127.0.0.1:${smtp.port}`, 'no-reply@example.com');
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' })).rejects.toThrow();
    expect(smtp.received).toEqual([]);
  });

  it('fails (and does not hang) when nothing listens on the port', async () => {
    const smtp = await startSmtp();
    const { port } = smtp;
    await smtp.close();
    const mailer = new SmtpMailer(`smtp://mailer:x@127.0.0.1:${port}`, 'no-reply@example.com');
    await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' })).rejects.toThrow();
  });
});
