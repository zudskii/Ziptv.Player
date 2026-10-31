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
  if (value.length === 0) return 'Enter your email address.';
  if (value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.';
  return null;
}

export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (password.trim().length === 0) return 'The password cannot be only spaces.';
  const normalized = normalizeEmail(email);
  if (normalized) {
    const local = normalized.split('@')[0] ?? '';
    if (password.toLowerCase() === normalized || (local.length >= 4 && password.toLowerCase() === local)) return 'The password must not be the same as your email.';
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
  else if (input.confirm !== input.password) issues.confirm = 'The passwords do not match.';
  return issues;
}

/** Logging in only needs something to send; whether it is right is the server's call. */
export function validateLogin(input: { email: string; password: string }): FormIssues {
  const issues: FormIssues = {};
  const email = emailProblem(input.email);
  if (email) issues.email = email;
  if (input.password.length === 0) issues.password = 'Enter your password.';
  return issues;
}

export const hasIssues = (issues: FormIssues): boolean => Object.keys(issues).length > 0;

/**
 * Where to go after signing in. Only same-app paths are accepted: a `from` that could point at
 * another site (`//evil.example`, `https://…`, `/\evil`) would turn the login page into an open redirect.
 */
export function safeRedirect(from: unknown, fallback = '/'): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return fallback;
  if (/^\/(login|register)(\/|\?|$)/.test(from)) return fallback;
  return from;
}

/** "Chrome on Windows" from a User-Agent string, for the list of signed-in devices. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
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
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}
