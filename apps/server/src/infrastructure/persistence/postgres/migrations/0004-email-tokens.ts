import { sql, type Kysely } from 'kysely';

/**
 * Links in emails: confirming an address and resetting a password.
 *
 *  - `users.email_verified_at`: when the person proved they own the address. Existing accounts
 *    start unconfirmed; nothing is blocked on it, it only unlocks "this address is confirmed".
 *  - `email_tokens`: one row per link sent. Only the SHA-256 of the token is stored (a database
 *    leak gives no usable link); `used_at` makes a link single-use; `email` pins the token to the
 *    address it was sent to.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

CREATE TABLE email_tokens (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash text        NOT NULL UNIQUE,
  email      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX email_tokens_user_idx    ON email_tokens (user_id, purpose);
CREATE INDEX email_tokens_expires_idx ON email_tokens (expires_at);
`,
    )
    .execute(db);
}
