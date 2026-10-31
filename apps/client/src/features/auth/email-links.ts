/**
 * Links in emails carry their secret in the URL fragment (`/reset-password#token=…`), which
 * browsers never send to servers: it stays out of server logs and Referer headers.
 */
const TOKEN_IN_FRAGMENT = /^#token=([A-Za-z0-9_-]{43})$/;

/** The token of an email link, or null when the fragment is missing or malformed. */
export function tokenFromFragment(hash: string): string | null {
  return TOKEN_IN_FRAGMENT.exec(hash)?.[1] ?? null;
}
