/**
 * Account credential rules (pure): what an email looks like after normalisation and what
 * passwords are acceptable. HTTP validation only checks shape and size; the policy is here so
 * it applies no matter how an account is created.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** Upper bound protects the hasher from megabyte-sized "passwords". */
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;

/** Emails are compared case-insensitively and without surrounding whitespace. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Why a password is not acceptable, or null when it is. Messages are shown to the user. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (password.trim().length === 0) return 'Password must not be only spaces.';
  if (email) {
    const normalized = normalizeEmail(email);
    const local = normalized.split('@')[0] ?? '';
    if (password.toLowerCase() === normalized || (local.length >= 4 && password.toLowerCase() === local)) {
      return 'Password must not be the same as your email.';
    }
  }
  return null;
}

export type UserRole = 'user' | 'admin';

/** A guest is an anonymous device identity: it has no email (and no password) yet. */
export function isGuest(user: { email: string | null }): boolean {
  return user.email === null;
}
