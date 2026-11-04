/**
 * What the app does with a device's identity. Pure, so the rules that protect people's data and
 * decide where they land are tested on their own.
 *
 * Three kinds of device:
 * - **anonymous**: no session at all (first visit, or signed out). Nothing is created behind the
 *   person's back: they choose on the welcome page (sign in, register, or continue as a guest).
 * - **guest**: an anonymous identity the person chose. If its token is rejected, a new guest is
 *   started silently — there is nothing to lose.
 * - **account**: if its token is rejected the person must sign in again; silently starting a guest
 *   would land them in an empty app and look like data loss.
 */
export interface SessionSnapshot {
  token: string | null;
  /** Set once the device has signed in to (or registered) an account; null for a guest. */
  account: { email: string } | null;
  /** The last thing that happened on this device was a deliberate sign-out. */
  signedOut?: boolean;
}

export type UnauthorizedAction = 'start-guest' | 'sign-in' | 'none';

/**
 * The server answered 401. `session` is the state the request was sent with:
 * an account must sign in; a guest whose token was rejected gets a new guest; a device with no
 * session at all (first visit, signed out) gets nothing — a stray request must never create an
 * identity the person did not choose.
 */
export function onUnauthorized(session: Pick<SessionSnapshot, 'account' | 'token'>): UnauthorizedAction {
  if (session.account) return 'sign-in';
  return session.token ? 'start-guest' : 'none';
}

/** The token is gone but the device belongs to an account: the person has to sign in again. */
export function needsSignIn(session: SessionSnapshot): boolean {
  return session.token === null && session.account !== null;
}

/**
 * What a protected route does for this device:
 * - `render` — a session exists;
 * - `sign-in-again` — an account lost its token (`/login`, the email kept, then back here);
 * - `sign-in` — signed out on purpose (`/login`, starting fresh: no way back to the last person's page);
 * - `restore-guest` — a 1.x guest id is on the device: keep that person's data, no questions;
 * - `welcome` — a first visit (`/welcome`, then back here).
 */
export type GateDecision = 'render' | 'sign-in-again' | 'sign-in' | 'restore-guest' | 'welcome';

export function gateDecision(session: SessionSnapshot, hasLegacyGuest = false): GateDecision {
  if (session.token) return 'render';
  if (session.account) return 'sign-in-again';
  if (hasLegacyGuest) return 'restore-guest';
  return session.signedOut ? 'sign-in' : 'welcome';
}
