import { describe, expect, it } from 'vitest';

import { loadConfig } from './env.js';

const BASE = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', STREAM_TOKEN_SECRET: 's'.repeat(40), DATA_ENCRYPTION_KEY: 'k'.repeat(40), NODE_ENV: 'test' };

describe('mail configuration', () => {
  it('has email off by default', () => {
    expect(loadConfig(BASE).mail).toEqual({ smtpUrl: null, from: null, logOnly: false });
    expect(loadConfig(BASE).publicUrl).toBeNull();
  });

  it('treats empty values as unset (docker-compose passes unset variables as empty strings)', () => {
    const config = loadConfig({ ...BASE, SMTP_URL: '', MAIL_FROM: '', PUBLIC_URL: '' });
    expect(config.mail).toEqual({ smtpUrl: null, from: null, logOnly: false });
    expect(config.publicUrl).toBeNull();
  });

  it('accepts a complete SMTP setup and drops a trailing slash from the public address', () => {
    const config = loadConfig({ ...BASE, SMTP_URL: 'smtps://user:p%40ss@smtp.example.com:465', MAIL_FROM: 'ZIPTV <no-reply@example.com>', PUBLIC_URL: 'https://tv.example.com/' });
    expect(config.mail).toEqual({ smtpUrl: 'smtps://user:p%40ss@smtp.example.com:465', from: 'ZIPTV <no-reply@example.com>', logOnly: false });
    expect(config.publicUrl).toBe('https://tv.example.com');
  });

  it('refuses an incomplete setup instead of silently sending nothing', () => {
    expect(() => loadConfig({ ...BASE, SMTP_URL: 'smtp://h:25', PUBLIC_URL: 'https://tv.example.com' })).toThrow(/MAIL_FROM/);
    // Links in emails are built from PUBLIC_URL; without it a request could decide where an email's link points.
    expect(() => loadConfig({ ...BASE, SMTP_URL: 'smtp://h:25', MAIL_FROM: 'a@example.com' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...BASE, SMTP_URL: 'not a url', MAIL_FROM: 'a@example.com', PUBLIC_URL: 'https://tv.example.com' })).toThrow();
  });

  it('keeps log-only mail (which prints reset links) out of production', () => {
    expect(loadConfig({ ...BASE, MAIL_LOG_ONLY: 'true' }).mail.logOnly).toBe(true);
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production', MAIL_LOG_ONLY: 'true', TRUST_PROXY: '1', ALLOWED_ORIGINS: 'https://tv.example.com' }),
    ).toThrow(/MAIL_LOG_ONLY/);
  });
});
