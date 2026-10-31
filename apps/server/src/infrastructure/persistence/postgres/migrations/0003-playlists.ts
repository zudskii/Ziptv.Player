import { sql, type Kysely } from 'kysely';

/**
 * Playlists: user-built, editable channel lists.
 *
 *  - An entry *points at* a source channel (source_id + source_key) instead of copying its stream
 *    URL, so URLs stay current when the provider rotates tokens; everything the user edits (name,
 *    logo, number, group, order) lives in the entry and survives re-syncs.
 *  - Whether the channel still exists is not stored: it is derived by joining the entry to the
 *    source's current catalog revision, so it is always right and needs no bookkeeping.
 *  - A source channel appears at most once per playlist (UNIQUE), which makes "add all" idempotent.
 *  - `origin_name_key` remembers the channel's normalised name at add time, to re-attach the
 *    entry when a provider re-groups it (the catalog key includes the group).
 *  - Group names are unique per playlist, case-insensitively. Deleting a source removes its
 *    entries; deleting a group is handled by the application (entries become ungrouped).
 *  - The export link token is stored hashed (lookup) and sealed (so the owner can see it again).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE playlists (
  id                  uuid        PRIMARY KEY,
  owner_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  export_token_hash   text        UNIQUE,
  export_token_sealed text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playlists_export_token_complete CHECK ((export_token_hash IS NULL) = (export_token_sealed IS NULL))
);
CREATE INDEX playlists_owner_idx ON playlists (owner_id, created_at);

CREATE TABLE playlist_groups (
  id          uuid    PRIMARY KEY,
  playlist_id uuid    NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  name        text    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  position    integer NOT NULL
);
CREATE UNIQUE INDEX playlist_groups_name_uq  ON playlist_groups (playlist_id, lower(name));
CREATE INDEX        playlist_groups_order_idx ON playlist_groups (playlist_id, position);

CREATE TABLE playlist_entries (
  id              uuid        PRIMARY KEY,
  playlist_id     uuid        NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  group_id        uuid        REFERENCES playlist_groups (id) ON DELETE SET NULL,
  position        integer     NOT NULL,
  number          integer     CHECK (number IS NULL OR number BETWEEN 1 AND 99999),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  logo            text,
  tvg_id          text,
  source_id       uuid        NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  source_key      text        NOT NULL,
  origin_name_key text        NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playlist_id, source_id, source_key)
);
CREATE INDEX playlist_entries_order_idx  ON playlist_entries (playlist_id, group_id, position);
CREATE INDEX playlist_entries_source_idx ON playlist_entries (source_id);
`,
    )
    .execute(db);
}
