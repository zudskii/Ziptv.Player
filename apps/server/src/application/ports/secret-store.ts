/**
 * Where operational secrets live (provider API keys, payment credentials, webhook secrets).
 * Records store a *reference*, never the secret: rotating a key or moving to a secrets manager
 * changes the store, not every row that uses it.
 *
 *   env:ZIPTV_SECRET_* — process environment (12-factor, Docker/Render secrets); only that prefix
 *   enc:<ciphertext>  — encrypted in the database with DATA_ENCRYPTION_KEY
 *   (later) vault:/aws-sm: — an external secrets manager behind the same port
 */
export interface SecretStore {
  /** The secret, or throws when the reference is unknown/unresolvable (never returns a partial value). */
  resolve(reference: string): Promise<string>;
  /** A reference for a secret entered in the console (stored encrypted). */
  seal(secret: string): string;
}
