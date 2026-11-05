import { sql, type Kysely } from 'kysely';

/**
 * Per-profile library (Phase 14). Sources stay owned by the account (one copy of the credentials,
 * one Xtream connection budget); a profile sees the sources assigned to it.
 *
 *   profile_sources   which of the account's sources a profile sees
 *   notifications     + source_ids: notices about particular sources (sync failed, guide loaded)
 *                     reach only the profiles that see one of them; NULL = the whole account
 *
 * Backfill: every existing source is assigned to every existing profile of its account, so
 * nothing changes for anyone until they edit a profile's library.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE profile_sources (
  profile_id uuid        NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  source_id  uuid        NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, source_id)
);
CREATE INDEX profile_sources_source_idx ON profile_sources (source_id);

INSERT INTO profile_sources (profile_id, source_id)
SELECT p.id, s.id FROM profiles p JOIN sources s ON s.owner_id = p.user_id
ON CONFLICT DO NOTHING;

ALTER TABLE notifications ADD COLUMN source_ids uuid[];
`,
    )
    .execute(db);
}
