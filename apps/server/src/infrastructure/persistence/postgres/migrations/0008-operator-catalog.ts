import { sql, type Kysely } from 'kysely';

/**
 * Operator master catalog (Phase 6, ZP-ENT-03). Additive: the BYO (user source) tables are
 * untouched and keep working side by side.
 *
 *   providers ── provider_credentials (secret_ref only, never the secret)
 *       └── provider_streams   (what a provider offers; the ingestion/review queue)
 *              └── channel_feeds ── channel_master ── channel_aliases (dedup keys)
 *                                        ├── rights_grants (territory × device × model × time)
 *                                        └── lineup_channels ── lineups (per market, numbered)
 *
 * Invariants enforced here (the application enforces the rest):
 *  - one stream feeds at most one master channel (UNIQUE provider_stream_id);
 *  - an alias key identifies at most one channel (PRIMARY KEY (kind, key));
 *  - channel numbers are unique within a lineup.
 * Operator favourites and history reference `channel_master.id` (not a user source).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE providers (
  id                   uuid        PRIMARY KEY,
  slug                 text        NOT NULL UNIQUE,
  name                 text        NOT NULL,
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated')),
  integration_type     text        NOT NULL CHECK (integration_type IN ('m3u', 'xtream', 'mock')),
  -- non-secret settings (mock channel list, notes); credentials live in provider_credentials
  config               jsonb       NOT NULL DEFAULT '{}',
  host                 text        NOT NULL DEFAULT '',
  sync_interval_hours  integer     NOT NULL DEFAULT 6,
  sync_status          text        NOT NULL DEFAULT 'queued' CHECK (sync_status IN ('idle', 'queued', 'running', 'failed')),
  sync_last_attempt_at timestamptz,
  sync_last_success_at timestamptz,
  sync_next_at         timestamptz,
  sync_error           text,
  sync_failures        integer     NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_until          timestamptz,
  stats                jsonb       NOT NULL DEFAULT '{"streams":0,"matched":0,"pending":0,"gone":0}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_due_idx ON providers (sync_status, sync_next_at);

CREATE TABLE provider_credentials (
  provider_id uuid        PRIMARY KEY REFERENCES providers (id) ON DELETE CASCADE,
  -- env:ZIPTV_SECRET_* or enc:<ciphertext> (SecretStore); the value is a JSON connection document
  secret_ref  text        NOT NULL,
  rotated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id         uuid        PRIMARY KEY,
  slug       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_master (
  id             uuid        PRIMARY KEY,
  slug           text        NOT NULL UNIQUE,
  name           text        NOT NULL,
  origin_country text        CHECK (origin_country ~ '^[A-Z]{2}$'),
  languages      text[]      NOT NULL DEFAULT '{}',
  category_id    uuid        REFERENCES categories (id) ON DELETE SET NULL,
  logo           text,
  global_uid     text        UNIQUE,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  search         text        NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_master_search_trgm ON channel_master USING gin (search gin_trgm_ops);

CREATE TABLE channel_aliases (
  kind       text        NOT NULL CHECK (kind IN ('name', 'tvg_id', 'manual')),
  key        text        NOT NULL,
  channel_id uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
CREATE INDEX channel_aliases_channel_idx ON channel_aliases (channel_id);

CREATE TABLE provider_streams (
  id           uuid        PRIMARY KEY,
  provider_id  uuid        NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  external_id  text        NOT NULL,
  name         text        NOT NULL,
  tvg_id       text,
  groups       text[]      NOT NULL DEFAULT '{}',
  logo         text,
  kind         text        NOT NULL,
  -- encrypted StreamLocator (M3U) / provider reference (Xtream id): never sent to clients
  locator      text,
  xtream       jsonb,
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'ignored', 'gone')),
  channel_id   uuid        REFERENCES channel_master (id) ON DELETE SET NULL,
  match_method text        CHECK (match_method IN ('tvg_id', 'name', 'manual')),
  suggestion   uuid        REFERENCES channel_master (id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);
CREATE INDEX provider_streams_review_idx ON provider_streams (status, provider_id);
CREATE INDEX provider_streams_channel_idx ON provider_streams (channel_id);

CREATE TABLE channel_feeds (
  id                 uuid        PRIMARY KEY,
  channel_id         uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  provider_id        uuid        NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  provider_stream_id uuid        NOT NULL UNIQUE REFERENCES provider_streams (id) ON DELETE CASCADE,
  priority           integer     NOT NULL DEFAULT 100,
  delivery_mode      text        NOT NULL DEFAULT 'proxy' CHECK (delivery_mode IN ('proxy')),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_feeds_channel_idx ON channel_feeds (channel_id, priority);

CREATE TABLE rights_grants (
  id              uuid        PRIMARY KEY,
  channel_id      uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  -- ISO 3166-1 alpha-2, or '*' for worldwide
  territory       text        NOT NULL CHECK (territory = '*' OR territory ~ '^[A-Z]{2}$'),
  device_classes  text[]      NOT NULL CHECK (cardinality(device_classes) > 0),
  business_models text[]      NOT NULL CHECK (cardinality(business_models) > 0),
  start_at        timestamptz NOT NULL,
  end_at          timestamptz CHECK (end_at IS NULL OR end_at > start_at),
  contract_ref    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by      uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);
CREATE INDEX rights_grants_channel_idx ON rights_grants (channel_id, territory) WHERE status = 'active';

CREATE TABLE lineups (
  id         uuid        PRIMARY KEY,
  slug       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  country    text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  status     text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lineup_channels (
  lineup_id  uuid    NOT NULL REFERENCES lineups (id) ON DELETE CASCADE,
  channel_id uuid    NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  number     integer NOT NULL CHECK (number > 0),
  PRIMARY KEY (lineup_id, channel_id),
  UNIQUE (lineup_id, number)
);
CREATE INDEX lineup_channels_channel_idx ON lineup_channels (channel_id);

CREATE TABLE operator_favorites (
  profile_id uuid        NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  channel_id uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, channel_id)
);
CREATE INDEX operator_favorites_channel_idx ON operator_favorites (channel_id);

-- History of operator channels: a viewing has either a user source or a master channel.
ALTER TABLE history ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE history ADD COLUMN channel_id uuid REFERENCES channel_master (id) ON DELETE CASCADE;
ALTER TABLE history ADD CONSTRAINT history_owner_check CHECK ((source_id IS NULL) <> (channel_id IS NULL));
ALTER TABLE history DROP CONSTRAINT history_content_type_check;
ALTER TABLE history ADD CONSTRAINT history_content_type_check CHECK (content_type IN ('channel', 'movie', 'episode', 'catchup', 'operator'));
CREATE INDEX history_channel_idx ON history (channel_id) WHERE channel_id IS NOT NULL;
`,
    )
    .execute(db);
}
