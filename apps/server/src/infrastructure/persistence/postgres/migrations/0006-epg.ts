import { sql, type Kysely } from 'kysely';

/**
 * EPG (Phase 3): XMLTV guides, their channels and programmes, and manual channel mappings.
 *
 *  - `guides`: one XMLTV URL per user (deduplicated by URL hash; the URL itself is encrypted),
 *    shared by the sources that announce or use it (`guide_sources`). Synced by the `epg-sync`
 *    worker under a lease; `generation` swaps atomically like a source revision.
 *  - `guide_channels` / `programmes`: rows of one generation; readers pin `(guide_id, generation)`.
 *    Only channels that some source links to keep their programmes (constant storage per user).
 *  - `epg_mappings`: the user's manual choice, keyed by stable channel keys (survives syncs).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE guides (
  id                   uuid        PRIMARY KEY,
  owner_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                 text        NOT NULL,
  origin               text        NOT NULL CHECK (origin IN ('playlist', 'xtream', 'manual')),
  url                  text        NOT NULL,
  url_hash             text        NOT NULL,
  host                 text        NOT NULL DEFAULT '',
  generation           integer     NOT NULL DEFAULT 0,
  -- highest generation number handed to a sync run (each run gets its own)
  next_generation      integer     NOT NULL DEFAULT 0,
  sync_status          text        NOT NULL DEFAULT 'queued' CHECK (sync_status IN ('idle', 'queued', 'running', 'failed')),
  sync_last_attempt_at timestamptz,
  sync_last_success_at timestamptz,
  sync_next_at         timestamptz,
  sync_error           text,
  sync_failures        integer     NOT NULL DEFAULT 0,
  sync_rerun           boolean     NOT NULL DEFAULT false,
  lease_owner          text,
  lease_until          timestamptz,
  stats                jsonb       NOT NULL DEFAULT '{"channels":0,"keptChannels":0,"programmes":0,"from":null,"to":null}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, url_hash)
);
CREATE INDEX guides_due_idx ON guides (sync_status, sync_next_at);

CREATE TABLE guide_sources (
  guide_id  uuid NOT NULL REFERENCES guides (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  PRIMARY KEY (guide_id, source_id)
);
CREATE INDEX guide_sources_source_idx ON guide_sources (source_id);

CREATE TABLE guide_channels (
  guide_id   uuid    NOT NULL REFERENCES guides (id) ON DELETE CASCADE,
  generation integer NOT NULL,
  id         text    NOT NULL,
  names      text[]  NOT NULL DEFAULT '{}',
  icon       text,
  kept       boolean NOT NULL DEFAULT false,
  -- ' token token ' (normalised): prefix search with LIKE '% term%'
  search     text    NOT NULL DEFAULT '',
  PRIMARY KEY (guide_id, generation, id)
);

CREATE TABLE programmes (
  guide_id    uuid        NOT NULL REFERENCES guides (id) ON DELETE CASCADE,
  generation  integer     NOT NULL,
  channel_id  text        NOT NULL,
  start_at    timestamptz NOT NULL,
  stop_at     timestamptz NOT NULL,
  title       text        NOT NULL,
  subtitle    text,
  description text,
  categories  text[]      NOT NULL DEFAULT '{}',
  icon        text,
  episode     text,
  rating      text,
  search      text        NOT NULL DEFAULT ''
);
CREATE INDEX programmes_channel_idx ON programmes (guide_id, generation, channel_id, start_at);
CREATE INDEX programmes_time_idx    ON programmes (guide_id, generation, start_at);
CREATE INDEX programmes_stop_idx    ON programmes (stop_at);

CREATE TABLE epg_mappings (
  owner_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id      uuid        NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  channel_key    text        NOT NULL,
  guide_id       uuid        NOT NULL REFERENCES guides (id) ON DELETE CASCADE,
  epg_channel_id text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, source_id, channel_key)
);
CREATE INDEX epg_mappings_guide_idx ON epg_mappings (guide_id);
`,
    )
    .execute(db);
}
