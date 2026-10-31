/**
 * What the app does when the server stops accepting its token. Pure, so the rule that protects
 * people's data is tested on its own.
 *
 * A guest has nothing to lose but an empty identity: start a new one silently. An account is
 * different — if the app silently started a new guest, the person would land in an empty app
 * and believe their sources and playlists were gone. They must be asked to sign in instead.
 */
export interface SessionSnapshot {
  token: string | null;
  /** Set once the device has signed in to (or registered) an account; null for a guest. */
  account: { email: string } | null;
}

export type UnauthorizedAction = 'start-guest' | 'sign-in';

export function onUnauthorized(session: Pick<SessionSnapshot, 'account'>): UnauthorizedAction {
  return session.account ? 'sign-in' : 'start-guest';
}

/** The token is gone but the device belongs to an account: the person has to sign in again. */
export function needsSignIn(session: SessionSnapshot): boolean {
  return session.token === null && session.account !== null;
}
