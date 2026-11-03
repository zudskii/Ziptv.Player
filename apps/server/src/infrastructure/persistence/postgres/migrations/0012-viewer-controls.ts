import { sql, type Kysely } from 'kysely';

/**
 * Catch-up and parental controls (Phase 10).
 *
 *   provider_streams   + catchup: the provider's archive capability of a licensed stream
 *   rights_grants      + catchup_days: catch-up is licensed separately from live (0 = live only)
 *   playback_sessions  + archive_start / archive_end: an authorized catch-up viewing
 *   parental_pins      one PIN per account (scrypt), failure counter and lock-out; `version`
 *                      invalidates unlock tokens whenever the PIN changes
 *   parental_rules     per profile: hide adult, locked groups / channels (BYO and operator)
 *   profiles           + pin_protected: opening the profile needs the PIN
 *   sessions           + kids_lock_profile_id: a device that entered a kids profile stays in it
 *                      until the PIN is given; + open_profile_id: the PIN-protected profile
 *                      opened on this device with the PIN
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE provider_streams ADD COLUMN catchup jsonb;
ALTER TABLE rights_grants ADD COLUMN catchup_days smallint NOT NULL DEFAULT 0 CHECK (catchup_days BETWEEN 0 AND 30);

ALTER TABLE playback_sessions ADD COLUMN archive_start timestamptz;
ALTER TABLE playback_sessions ADD COLUMN archive_end   timestamptz;
ALTER TABLE playback_sessions ADD CONSTRAINT playback_sessions_archive_check
  CHECK ((archive_start IS NULL AND archive_end IS NULL) OR (archive_start IS NOT NULL AND archive_end > archive_start));

CREATE TABLE parental_pins (
  user_id      uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pin_hash     text        NOT NULL,
  version      integer     NOT NULL DEFAULT 1,
  failures     integer     NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parental_rules (
  profile_id      uuid        PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  hide_adult      boolean     NOT NULL DEFAULT false,
  locked_groups   jsonb       NOT NULL DEFAULT '[]',
  locked_channels jsonb       NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ADD COLUMN pin_protected boolean NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN kids_lock_profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN open_profile_id      uuid REFERENCES profiles (id) ON DELETE SET NULL;
`,
    )
    .execute(db);
}
