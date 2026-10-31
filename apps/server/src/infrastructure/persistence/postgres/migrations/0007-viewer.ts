import { sql, type Kysely } from 'kysely';

/**
 * Viewer experience (Phase 5): profiles and per-profile user state, plus trigram search.
 *
 *  - `profiles`: up to N per account; exactly one default (partial unique index). Settings are
 *    one jsonb document per profile (merged with defaults in the domain layer).
 *  - `list_items` (My List), `progress` (Continue Watching), `history` (every viewing, live
 *    included): keyed by stable catalog keys, so they survive source syncs. `source_id` cascades:
 *    removing a source removes its user state. Title/image are snapshots for items that
 *    disappear from a later revision.
 *  - `history.id` is the playback session id of the plan, so events from any instance update
 *    the same row without shared memory.
 *  - `search` (' token token '): normalised names for LIKE '% term%' with pg_trgm GIN indexes,
 *    on catalog tables (unified search) and programmes (EPG search, previously a scan).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE profiles (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  color      text        NOT NULL,
  kind       text        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'kids')),
  is_default boolean     NOT NULL DEFAULT false,
  settings   jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_user_idx ON profiles (user_id, created_at);
CREATE UNIQUE INDEX profiles_one_default_idx ON profiles (user_id) WHERE is_default;

CREATE TABLE list_items (
  profile_id uuid        NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  source_id  uuid        NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  type       text        NOT NULL CHECK (type IN ('channel', 'movie', 'series')),
  key        text        NOT NULL,
  title      text        NOT NULL,
  subtitle   text,
  image      text,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, source_id, type, key)
);
CREATE INDEX list_items_recent_idx ON list_items (profile_id, added_at DESC);
CREATE INDEX list_items_source_idx ON list_items (source_id);

CREATE TABLE progress (
  profile_id   uuid             NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  source_id    uuid             NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  content_type text             NOT NULL CHECK (content_type IN ('movie', 'episode')),
  -- '' for movies (part of the key, so not nullable)
  series_key   text             NOT NULL DEFAULT '',
  key          text             NOT NULL,
  season       integer,
  episode      integer,
  title        text             NOT NULL,
  series_title text,
  image        text,
  position     double precision NOT NULL,
  duration     double precision NOT NULL,
  completed    boolean          NOT NULL DEFAULT false,
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, source_id, content_type, series_key, key)
);
CREATE INDEX progress_recent_idx ON progress (profile_id, updated_at DESC);
CREATE INDEX progress_source_idx ON progress (source_id);

CREATE TABLE history (
  id              uuid             PRIMARY KEY,
  profile_id      uuid             NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  source_id       uuid             NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  content_type    text             NOT NULL CHECK (content_type IN ('channel', 'movie', 'episode', 'catchup')),
  key             text             NOT NULL,
  series_key      text,
  season          integer,
  episode         integer,
  title           text             NOT NULL,
  subtitle        text,
  series_title    text,
  image           text,
  started_at      timestamptz      NOT NULL DEFAULT now(),
  watched_at      timestamptz      NOT NULL DEFAULT now(),
  watched_secs    double precision NOT NULL DEFAULT 0,
  programme_start timestamptz,
  programme_end   timestamptz
);
CREATE INDEX history_recent_idx ON history (profile_id, watched_at DESC);
CREATE INDEX history_source_idx ON history (source_id);
CREATE INDEX history_age_idx ON history (watched_at);

ALTER TABLE live_channels ADD COLUMN search text NOT NULL DEFAULT '';
ALTER TABLE movies        ADD COLUMN search text NOT NULL DEFAULT '';
ALTER TABLE series        ADD COLUMN search text NOT NULL DEFAULT '';
UPDATE live_channels SET search = ' ' || array_to_string(search_tokens, ' ') || ' ';
UPDATE movies        SET search = ' ' || array_to_string(search_tokens, ' ') || ' ';
UPDATE series        SET search = ' ' || array_to_string(search_tokens, ' ') || ' ';
CREATE INDEX live_channels_search_trgm ON live_channels USING gin (search gin_trgm_ops);
CREATE INDEX movies_search_trgm        ON movies        USING gin (search gin_trgm_ops);
CREATE INDEX series_search_trgm        ON series        USING gin (search gin_trgm_ops);
CREATE INDEX programmes_search_trgm    ON programmes    USING gin (search gin_trgm_ops);

-- "Recently added" lists order by added_at DESC NULLS LAST (undated items last), then provider
-- order; the 0001 indexes (plain DESC = NULLS FIRST) cannot serve that ordering.
DROP INDEX movies_added_idx;
DROP INDEX series_added_idx;
CREATE INDEX movies_added_idx ON movies (source_id, revision, added_at DESC NULLS LAST, position);
CREATE INDEX series_added_idx ON series (source_id, revision, added_at DESC NULLS LAST, position);
`,
    )
    .execute(db);
}
