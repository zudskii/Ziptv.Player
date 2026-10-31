import { describe, expect, it } from 'vitest';

import { describeDevice, emailProblem, hasIssues, passwordProblem, safeRedirect, validateLogin, validateRegistration } from './credentials';

describe('email and password checks', () => {
  it('accepts normal addresses and rejects malformed ones', () => {
    expect(emailProblem('giorgi@example.com')).toBeNull();
    expect(emailProblem('  giorgi@example.com  ')).toBeNull();
    for (const bad of ['', '   ', 'giorgi', 'giorgi@', '@example.com', 'a b@example.com', 'a@b', `${'x'.repeat(250)}@example.com`]) {
      expect(emailProblem(bad), bad).not.toBeNull();
    }
  });

  it('applies the same password policy as the server', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
    expect(passwordProblem('პაროლი-ძალიან-გრძელი')).toBeNull();
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('          ')).toMatch(/only spaces/);
    expect(passwordProblem('Zurab@Example.com', 'zurab@example.com')).toMatch(/same as your email/);
    expect(passwordProblem('zurabbbb', 'zurabbbb@example.com')).toMatch(/same as your email/);
  });

  it('collects every problem of a registration, and checks the confirmation only once the password is fine', () => {
    expect(hasIssues(validateRegistration({ email: 'a@example.com', password: 'correct horse', confirm: 'correct horse' }))).toBe(false);
    expect(validateRegistration({ email: 'nope', password: 'short', confirm: 'x' })).toEqual({ email: 'Enter a valid email address.', password: 'Use at least 8 characters.' });
    expect(validateRegistration({ email: 'a@example.com', password: 'correct horse', confirm: 'correct hors' })).toEqual({ confirm: 'The passwords do not match.' });
  });

  it('does not judge an existing password on login, only that one was entered', () => {
    expect(validateLogin({ email: 'a@example.com', password: 'x' })).toEqual({});
    expect(validateLogin({ email: '', password: '' })).toEqual({ email: 'Enter your email address.', password: 'Enter your password.' });
  });
});

describe('safeRedirect', () => {
  it('keeps paths inside the app', () => {
    expect(safeRedirect('/playlists/abc?x=1')).toBe('/playlists/abc?x=1');
    expect(safeRedirect('/')).toBe('/');
  });

  it('refuses anything that could leave the app or loop back to the sign-in pages', () => {
    for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/\\evil.example', 'evil', '', undefined, null, 42, '/login', '/register?x=1']) {
      expect(safeRedirect(bad), String(bad)).toBe('/');
    }
    expect(safeRedirect('//evil.example', '/live')).toBe('/live');
  });
});

describe('describeDevice', () => {
  it('names browser and system', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeDevice('Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0')).toBe('Firefox on Android');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('curl/8.0')).toBe('Unknown device');
  });
});
