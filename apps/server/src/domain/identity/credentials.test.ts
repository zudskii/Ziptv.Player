import { describe, expect, it } from 'vitest';

import { isGuest, MAX_PASSWORD_LENGTH, normalizeEmail, passwordProblem } from './credentials.js';

describe('credentials', () => {
  it('normalises emails (case and surrounding whitespace)', () => {
    expect(normalizeEmail('  Zurab@Example.COM ')).toBe('zurab@example.com');
  });

  it('accepts reasonable passwords, including passphrases and non-Latin text', () => {
    expect(passwordProblem('correct horse battery staple')).toBeNull();
    expect(passwordProblem('პაროლი-ძალიან-გრძელი')).toBeNull();
    expect(passwordProblem('12345678')).toBeNull(); // length is the policy; we do not invent composition rules
  });

  it('rejects too short, too long, blank and email-like passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most 128/);
    expect(passwordProblem('          ')).toMatch(/only spaces/);
    expect(passwordProblem('Zurab@Example.com', 'zurab@example.com')).toMatch(/same as your email/);
    expect(passwordProblem('zurabbbb', 'zurabbbb@example.com')).toMatch(/same as your email/);
    expect(passwordProblem('abc', 'abc@example.com')).toMatch(/at least 8/); // short local parts only fail on length
  });

  it('tells guests from accounts by the absence of an email', () => {
    expect(isGuest({ email: null })).toBe(true);
    expect(isGuest({ email: 'a@b.co' })).toBe(false);
  });
});
