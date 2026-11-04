import { describe, expect, it } from 'vitest';

import { gateDecision, needsSignIn, onUnauthorized } from './session-policy';

const account = { email: 'a@example.com' };

describe('session policy', () => {
  it('starts a new guest silently when a guest token is rejected', () => {
    expect(onUnauthorized({ token: 'guest', account: null })).toBe('start-guest');
  });

  it('never replaces an account session with an empty guest: it asks to sign in', () => {
    expect(onUnauthorized({ token: 'expired', account })).toBe('sign-in');
    expect(onUnauthorized({ token: null, account })).toBe('sign-in');
  });

  it('never creates an identity from a stray request of a device without a session', () => {
    expect(onUnauthorized({ token: null, account: null })).toBe('none');
  });

  it('needs a sign-in exactly when an account lost its token', () => {
    expect(needsSignIn({ token: null, account })).toBe(true);
    expect(needsSignIn({ token: 'abc', account })).toBe(false);
    expect(needsSignIn({ token: null, account: null })).toBe(false);
    expect(needsSignIn({ token: 'abc', account: null })).toBe(false);
  });
});

describe('where a protected screen sends the device', () => {
  it('renders for any session, guest or account', () => {
    expect(gateDecision({ token: 'abc', account: null })).toBe('render');
    expect(gateDecision({ token: 'abc', account, signedOut: true })).toBe('render');
  });

  it('a first visit goes to the welcome page — nothing is created behind the person’s back', () => {
    expect(gateDecision({ token: null, account: null })).toBe('welcome');
  });

  it('after signing out on purpose, the sign-in page', () => {
    expect(gateDecision({ token: null, account: null, signedOut: true })).toBe('sign-in');
  });

  it('an account whose session ended signs in again (and comes back)', () => {
    expect(gateDecision({ token: null, account })).toBe('sign-in-again');
    expect(gateDecision({ token: null, account }, true)).toBe('sign-in-again');
  });

  it('a 1.x guest keeps its data without being asked anything', () => {
    expect(gateDecision({ token: null, account: null }, true)).toBe('restore-guest');
    expect(gateDecision({ token: null, account: null, signedOut: true }, true)).toBe('restore-guest');
  });
});
