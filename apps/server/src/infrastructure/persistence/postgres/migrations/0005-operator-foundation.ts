import { sql, type Kysely } from 'kysely';

/**
 * Operator console foundation (Phase 2).
 *
 *  - `staff_users` / `staff_sessions`: console identities, separate from subscriber accounts.
 *    Passwords are scrypt hashes, TOTP secrets are encrypted by the application, sessions are
 *    stored as SHA-256 of the token with idle + absolute expiry.
 *  - `admin_audit_logs`: append-only, hash-chained. `seq` is assigned under an advisory lock so
 *    the chain never forks; a trigger refuses UPDATE, DELETE and TRUNCATE. `actor_id` has no
 *    foreign key on purpose: history must outlive the account it mentions.
 *  - `outbox`: side effects (emails, notifications, later billing calls) written in the same
 *    transaction as the change that causes them and delivered by a worker, at least once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE staff_users (
  id                   uuid        PRIMARY KEY,
  email                text        NOT NULL UNIQUE,
  name                 text        NOT NULL,
  password_hash        text        NOT NULL,
  role                 text        NOT NULL CHECK (role IN ('SUPER_ADMIN', 'CONTENT_MANAGER', 'NOC_OPERATOR', 'SUPPORT_AGENT', 'FINANCE', 'VIEW_ONLY')),
  mfa_secret           text,
  mfa_enabled_at       timestamptz,
  mfa_last_step        bigint,
  mfa_failures         integer     NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  must_change_password boolean     NOT NULL DEFAULT true,
  disabled_at          timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);

CREATE TABLE staff_sessions (
  id                  uuid        PRIMARY KEY,
  staff_id            uuid        NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  token_hash          text        NOT NULL UNIQUE,
  ip                  text,
  user_agent          text,
  created_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);
CREATE INDEX staff_sessions_staff_idx   ON staff_sessions (staff_id);
CREATE INDEX staff_sessions_expires_idx ON staff_sessions (idle_expires_at);

CREATE TABLE admin_audit_logs (
  seq          bigint      PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  actor_id     uuid,
  actor_email  text,
  action       text        NOT NULL,
  target_type  text,
  target_id    text,
  before_hash  text,
  after_hash   text,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  prev_hash    text        NOT NULL,
  hash         text        NOT NULL UNIQUE
);
CREATE INDEX admin_audit_logs_time_idx   ON admin_audit_logs (occurred_at);
CREATE INDEX admin_audit_logs_actor_idx  ON admin_audit_logs (actor_id, seq);
CREATE INDEX admin_audit_logs_target_idx ON admin_audit_logs (target_type, target_id, seq);
CREATE INDEX admin_audit_logs_action_idx ON admin_audit_logs (action, seq);

CREATE FUNCTION admin_audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_logs is append-only (% refused)', TG_OP;
END;
$$;
CREATE TRIGGER admin_audit_logs_no_update BEFORE UPDATE OR DELETE ON admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_append_only();
CREATE TRIGGER admin_audit_logs_no_truncate BEFORE TRUNCATE ON admin_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_logs_append_only();

CREATE TABLE outbox (
  id           uuid        PRIMARY KEY,
  topic        text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,
  processed_at timestamptz,
  lease_owner  text,
  lease_until  timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE processed_at IS NULL;
`,
    )
    .execute(db);
}
