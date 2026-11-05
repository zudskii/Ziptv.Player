import { t } from '../../i18n';

/**
 * Client-side checks for the sign-in forms. They only save a round trip: the server applies the
 * same rules (and is the one that enforces them), so the wording and limits mirror its policy.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (value.length === 0) return t('auth.validation.emailRequired');
  if (value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return t('auth.validation.emailInvalid');
  return null;
}

export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return t('auth.validation.minChars', { count: MIN_PASSWORD_LENGTH });
  if (password.length > MAX_PASSWORD_LENGTH) return t('auth.validation.maxChars', { count: MAX_PASSWORD_LENGTH });
  if (password.trim().length === 0) return t('auth.validation.onlySpaces');
  const normalized = normalizeEmail(email);
  if (normalized) {
    const local = normalized.split('@')[0] ?? '';
    if (password.toLowerCase() === normalized || (local.length >= 4 && password.toLowerCase() === local)) return t('auth.validation.sameAsEmail');
  }
  return null;
}

export interface FormIssues {
  email?: string;
  password?: string;
  confirm?: string;
}

export function validateRegistration(input: { email: string; password: string; confirm: string }): FormIssues {
  const issues: FormIssues = {};
  const email = emailProblem(input.email);
  if (email) issues.email = email;
  const password = passwordProblem(input.password, input.email);
  if (password) issues.password = password;
  else if (input.confirm !== input.password) issues.confirm = t('auth.validation.mismatch');
  return issues;
}

/** Logging in only needs something to send; whether it is right is the server's call. */
export function validateLogin(input: { email: string; password: string }): FormIssues {
  const issues: FormIssues = {};
  const email = emailProblem(input.email);
  if (email) issues.email = email;
  if (input.password.length === 0) issues.password = t('auth.validation.passwordRequired');
  return issues;
}

export const hasIssues = (issues: FormIssues): boolean => Object.keys(issues).length > 0;

/**
 * Where to go after signing in. Only same-app paths are accepted: a `from` that could point at
 * another site (`//evil.example`, `https://…`, `/\evil`) would turn the login page into an open redirect.
 */
export function safeRedirect(from: unknown, fallback = '/'): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return fallback;
  // Pages that are only shown without a session would bounce straight back: a loop, not a destination.
  if (/^\/(login|register|welcome)(\/|\?|#|$)/.test(from)) return fallback;
  return from;
}

/** "Chrome on Windows" from a User-Agent string, for the list of signed-in devices. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return t('auth.unknownDevice');
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux|X11/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && os) return t('auth.deviceOn', { browser, os });
  return browser ?? os ?? t('auth.unknownDevice');
}
