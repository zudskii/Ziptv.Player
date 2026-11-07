import { sql, type Kysely } from 'kysely';

/**
 * Content provider foundation (Phase 16).
 *
 *   providers            + integration_type 'vendor_feed' (signed ZIPTV Vendor Feed v1),
 *                          sync_cursor (incremental syncs), feed_generated_at (replay guard)
 *   provider_streams     + rights: the rights a vendor feed delivers with a channel
 *   rights_grants        + origin 'feed' (kept in step with the vendor's signed feed by the sync,
 *                          one set per channel × provider) next to staff-made 'manual' grants,
 *                          + max_quality (quality limit)
 *   provider_vod / provider_episodes   movies and series a provider offers (ingest; Phase 17
 *                          decides how they are sold)
 *   provider_packages / provider_package_items   the vendor's bundles
 *   provider_sync_events the sync journal: what each sync did, and every item it skipped and why
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE providers DROP CONSTRAINT providers_integration_type_check;
ALTER TABLE providers ADD CONSTRAINT providers_integration_type_check CHECK (integration_type IN ('m3u', 'xtream', 'mock', 'vendor_feed'));
ALTER TABLE providers ADD COLUMN sync_cursor text;
ALTER TABLE providers ADD COLUMN feed_generated_at timestamptz;

ALTER TABLE provider_streams ADD COLUMN rights jsonb;

ALTER TABLE rights_grants ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'feed'));
ALTER TABLE rights_grants ADD COLUMN provider_id uuid REFERENCES providers (id) ON DELETE CASCADE;
ALTER TABLE rights_grants ADD COLUMN max_quality text CHECK (max_quality IN ('sd', 'hd', 'fhd', 'uhd'));
ALTER TABLE rights_grants ADD CONSTRAINT rights_grants_feed_provider CHECK ((origin = 'feed') = (provider_id IS NOT NULL));
CREATE INDEX rights_grants_feed_idx ON rights_grants (provider_id, channel_id) WHERE origin = 'feed';

CREATE TABLE provider_vod (
  id            uuid             PRIMARY KEY,
  provider_id   uuid             NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  external_id   text             NOT NULL,
  type          text             NOT NULL CHECK (type IN ('movie', 'series')),
  title         text             NOT NULL,
  year          integer,
  genres        text[]           NOT NULL DEFAULT '{}',
  genre_ids     text[]           NOT NULL DEFAULT '{}',
  poster        text,
  plot          text,
  duration_secs double precision,
  rating        double precision,
  -- encrypted StreamLocator (movies); series carry theirs per episode
  locator       text,
  rights        jsonb            NOT NULL DEFAULT '[]',
  packages      text[]           NOT NULL DEFAULT '{}',
  status        text             NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone')),
  first_seen_at timestamptz      NOT NULL DEFAULT now(),
  last_seen_at  timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);
CREATE INDEX provider_vod_list_idx ON provider_vod (provider_id, type, status);

CREATE TABLE provider_episodes (
  vod_id        uuid             NOT NULL REFERENCES provider_vod (id) ON DELETE CASCADE,
  external_id   text             NOT NULL,
  season        integer          NOT NULL,
  episode       integer          NOT NULL,
  title         text             NOT NULL,
  duration_secs double precision,
  locator       text,
  PRIMARY KEY (vod_id, external_id)
);

CREATE TABLE provider_packages (
  id            uuid        PRIMARY KEY,
  provider_id   uuid        NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  external_id   text        NOT NULL,
  name          text        NOT NULL,
  description   text,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);

CREATE TABLE provider_sync_events (
  id          uuid        PRIMARY KEY,
  provider_id uuid        NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  level       text        NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  code        text        NOT NULL,
  message     text        NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX provider_sync_events_idx ON provider_sync_events (provider_id, at DESC);
`,
    )
    .execute(db);
}
