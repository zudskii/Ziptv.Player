import { sql, type Kysely } from 'kysely';

/**
 * Accounts and sessions.
 *
 *  - `users` gains email + password (both NULL = guest, the anonymous device identity of 0001).
 *    The CHECKs keep the table honest even for writers other than this app: an account always
 *    has both, and emails are stored lower-cased so the unique index is case-insensitive.
 *  - Bearer tokens move out of `users` into `sessions`: one row per signed-in device, so a user
 *    can be signed in on several devices, sign one out, or all of them. Existing tokens keep
 *    working (their hashes are copied over; guest sessions never expire).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE users
  ADD COLUMN email         text,
  ADD COLUMN password_hash text,
  ADD COLUMN role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ADD CONSTRAINT users_email_is_normalised CHECK (email IS NULL OR email = lower(email)),
  ADD CONSTRAINT users_account_is_complete CHECK ((email IS NULL) = (password_hash IS NULL));
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at) WHERE expires_at IS NOT NULL;

INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at)
SELECT gen_random_uuid(), id, token_hash, created_at, last_seen_at FROM users;

ALTER TABLE users DROP COLUMN token_hash;
`,
    )
    .execute(db);
}
