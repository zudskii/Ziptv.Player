import { sql, type Kysely } from 'kysely';

/**
 * Commerce and playback authorization (Phase 8, ZP-ENT-07/08/09).
 *
 *   packages ── package_channels ── channel_master
 *   users ── subscriptions (state machine, one live per user) ── invoices
 *        └── entitlements (what grants access: from a subscription, or comp/B2B by staff)
 *        └── devices (registered, limited, revocable) ── playback_sessions (authorized viewings)
 *   checkouts      a purchase in progress at the processor (never access by itself)
 *   payment_events every processor webhook, once (UNIQUE processor + event id) — idempotency
 *   leases         concurrency leases when no Redis is configured (PostgreSQL fallback)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE users ADD COLUMN blocked_at timestamptz;
ALTER TABLE users ADD COLUMN blocked_reason text;

CREATE TABLE packages (
  id             uuid        PRIMARY KEY,
  slug           text        NOT NULL UNIQUE,
  name           text        NOT NULL,
  description    text        NOT NULL DEFAULT '',
  price_minor    integer     NOT NULL CHECK (price_minor >= 0),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_period text        NOT NULL CHECK (billing_period IN ('month', 'year')),
  trial_days     integer     NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  max_devices    integer     NOT NULL CHECK (max_devices BETWEEN 1 AND 50),
  max_streams    integer     NOT NULL CHECK (max_streams BETWEEN 1 AND 20),
  business_model text        NOT NULL DEFAULT 'subscription' CHECK (business_model IN ('subscription', 'b2b')),
  status         text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE package_channels (
  package_id uuid NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, channel_id)
);
CREATE INDEX package_channels_channel_idx ON package_channels (channel_id);

CREATE TABLE subscriptions (
  id                   uuid        PRIMARY KEY,
  user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  package_id           uuid        NOT NULL REFERENCES packages (id),
  status               text        NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'grace', 'canceled', 'expired')),
  trial_ends_at        timestamptz,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean     NOT NULL DEFAULT false,
  ended_at             timestamptz,
  processor            text        NOT NULL,
  processor_ref        text        NOT NULL,
  -- last comparison with the processor (reconciliation)
  reconciled_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (processor, processor_ref)
);
-- one live subscription per user (a second purchase must not double-bill)
CREATE UNIQUE INDEX subscriptions_live_uniq ON subscriptions (user_id) WHERE status NOT IN ('canceled', 'expired');
CREATE INDEX subscriptions_clock_idx ON subscriptions (status, current_period_end) WHERE status NOT IN ('canceled', 'expired');

CREATE TABLE entitlements (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  package_id      uuid        NOT NULL REFERENCES packages (id),
  kind            text        NOT NULL CHECK (kind IN ('subscription', 'comp')),
  subscription_id uuid        UNIQUE REFERENCES subscriptions (id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz,
  revoked_at      timestamptz,
  note            text,
  created_by      uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'subscription') = (subscription_id IS NOT NULL))
);
CREATE INDEX entitlements_user_idx ON entitlements (user_id);

CREATE TABLE devices (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the client's device key (the key itself never leaves the device)
  key_hash     text        NOT NULL,
  name         text        NOT NULL,
  platform     text        NOT NULL CHECK (platform IN ('web', 'mobile', 'tv', 'stb')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX devices_key_uniq ON devices (user_id, key_hash) WHERE revoked_at IS NULL;
CREATE INDEX devices_user_idx ON devices (user_id);

CREATE TABLE playback_sessions (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id        uuid        REFERENCES profiles (id) ON DELETE SET NULL,
  device_id         uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  channel_id        uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  access            text        NOT NULL CHECK (access IN ('package', 'fast', 'rights')),
  package_id        uuid        REFERENCES packages (id) ON DELETE SET NULL,
  country           text,
  started_at        timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  end_reason        text
);
CREATE INDEX playback_sessions_user_live_idx ON playback_sessions (user_id) WHERE ended_at IS NULL;
CREATE INDEX playback_sessions_expiry_idx ON playback_sessions (expires_at) WHERE ended_at IS NULL;
CREATE INDEX playback_sessions_channel_live_idx ON playback_sessions (channel_id) WHERE ended_at IS NULL;
CREATE INDEX playback_sessions_time_idx ON playback_sessions (started_at);

CREATE TABLE checkouts (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  package_id     uuid        NOT NULL REFERENCES packages (id),
  processor      text        NOT NULL,
  processor_ref  text,
  with_trial     boolean     NOT NULL DEFAULT false,
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired')),
  subscription_id uuid       REFERENCES subscriptions (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX checkouts_open_idx ON checkouts (created_at) WHERE status = 'open';

CREATE TABLE invoices (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subscription_id uuid        NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  processor       text        NOT NULL,
  processor_ref   text        NOT NULL,
  amount_minor    integer     NOT NULL,
  currency        text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('paid', 'refunded')),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  paid_at         timestamptz NOT NULL,
  refunded_at     timestamptz,
  UNIQUE (processor, processor_ref)
);
CREATE INDEX invoices_user_idx ON invoices (user_id, paid_at DESC);

CREATE TABLE payment_events (
  id           uuid        PRIMARY KEY,
  processor    text        NOT NULL,
  event_id     text        NOT NULL,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  received_at  timestamptz NOT NULL,
  processed_at timestamptz,
  outcome      text,
  UNIQUE (processor, event_id)
);
CREATE INDEX payment_events_time_idx ON payment_events (received_at);

CREATE TABLE leases (
  key        text        NOT NULL,
  holder     text        NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key, holder)
);
CREATE INDEX leases_expiry_idx ON leases (expires_at);
`,
    )
    .execute(db);
}
