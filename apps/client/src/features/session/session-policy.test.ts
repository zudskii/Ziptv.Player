import { describe, expect, it } from 'vitest';

import { needsSignIn, onUnauthorized } from './session-policy';

describe('session policy', () => {
  it('starts a new guest silently when a guest token is rejected', () => {
    expect(onUnauthorized({ account: null })).toBe('start-guest');
  });

  it('never replaces an account session with an empty guest: it asks to sign in', () => {
    expect(onUnauthorized({ account: { email: 'a@example.com' } })).toBe('sign-in');
  });

  it('needs a sign-in exactly when an account lost its token', () => {
    expect(needsSignIn({ token: null, account: { email: 'a@example.com' } })).toBe(true);
    expect(needsSignIn({ token: 'abc', account: { email: 'a@example.com' } })).toBe(false);
    expect(needsSignIn({ token: null, account: null })).toBe(false); // first visit: a guest is created
    expect(needsSignIn({ token: 'abc', account: null })).toBe(false);
  });
});
