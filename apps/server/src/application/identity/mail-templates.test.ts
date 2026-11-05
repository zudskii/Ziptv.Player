import { describe, expect, it } from 'vitest';

import { mailLocale, passwordResetMail, verifyEmailMail } from './mail-templates.js';

const LINK = 'https://tv.example.com/reset-password#token=abc_DEF-123';

describe('mail templates', () => {
  it('puts the link in both the text and the HTML version, with the expiry stated', () => {
    const mail = passwordResetMail(LINK, 60);
    expect(mail.subject).toBe('Reset your ZIPTV password');
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain('expires in 60 minutes');
    expect(mail.html).toContain(`href="${LINK}"`);
    const verify = verifyEmailMail(LINK, 24);
    expect(verify.text).toContain(LINK);
    expect(verify.text).toContain('24 hours');
  });

  it('cannot be broken by a hostile link: HTML-escaped wherever it is placed', () => {
    const hostile = 'https://x.example/"><script>alert(1)</script>';
    const { html } = passwordResetMail(hostile, 60);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('says what to do when the email was not asked for', () => {
    expect(passwordResetMail(LINK, 60).text).toMatch(/did not ask.*ignore/s);
    expect(verifyEmailMail(LINK, 24).text).toMatch(/did not create.*ignore/s);
  });

  it('is written in the language of the screen that asked (Accept-Language), English otherwise', () => {
    expect(mailLocale('ka')).toBe('ka');
    expect(mailLocale('ru-RU,ru;q=0.9,en;q=0.8')).toBe('ru');
    expect(mailLocale('de-DE, ka;q=0.5')).toBe('ka');
    expect(mailLocale('de-DE')).toBe('en');
    expect(mailLocale(undefined)).toBe('en');

    const ka = passwordResetMail(LINK, 60, 'ka');
    expect(ka.subject).toBe('ZIPTV-ის პაროლის აღდგენა');
    expect(ka.text).toContain(LINK);
    expect(ka.text).toContain('60 წუთში');
    expect(ka.html).toContain('lang="ka"');
    const ru = verifyEmailMail(LINK, 24, 'ru');
    expect(ru.subject).toBe('Подтвердите адрес почты для ZIPTV');
    expect(ru.html).toContain(`href="${LINK}"`);
    expect(ru.text).toContain('24 ч');
  });
});
