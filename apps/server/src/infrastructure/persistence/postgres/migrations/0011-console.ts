import { sql, type Kysely } from 'kysely';

/**
 * Operator console (Phase 9).
 *
 *   providers          + contract, SLA target and cost (partner management, finance)
 *   change_requests    four-eyes: package and rights changes wait for a second staff member
 *                      (mode `approval`); emergency rights revocations apply at once and wait
 *                      for a second staff member's review (mode `review`)
 *   support_notes      internal notes on a subscriber (support desk)
 *   playback_sessions  + provider_id: whose feed was served (usage-based partner reporting)
 *   operator_guides    XMLTV guides for the operator catalog (URL encrypted), synced in
 *   operator_guide_channels / operator_programmes   generations (swap like a source revision)
 *   channel_epg        master channel → guide channel (automatic by alias, or manual)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE providers ADD COLUMN contract_ref       text;
ALTER TABLE providers ADD COLUMN contract_start_at  timestamptz;
ALTER TABLE providers ADD COLUMN contract_end_at    timestamptz;
ALTER TABLE providers ADD COLUMN sla_target_pct     numeric(5, 2) CHECK (sla_target_pct IS NULL OR (sla_target_pct > 0 AND sla_target_pct <= 100));
ALTER TABLE providers ADD COLUMN monthly_cost_minor integer CHECK (monthly_cost_minor IS NULL OR monthly_cost_minor >= 0);
ALTER TABLE providers ADD COLUMN cost_currency      text;
ALTER TABLE providers ADD COLUMN notes              text NOT NULL DEFAULT '';

CREATE TABLE change_requests (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('package.create', 'package.update', 'rights.grant', 'rights.revoke')),
  mode          text        NOT NULL CHECK (mode IN ('approval', 'review')),
  status        text        NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'withdrawn', 'failed', 'reviewed')),
  target_type   text        NOT NULL,
  target_id     uuid,
  payload       jsonb       NOT NULL,
  summary       text        NOT NULL,
  -- state hash of the target when requested: an approval of a stale request is refused
  base_hash     text,
  requested_by  uuid        NOT NULL REFERENCES staff_users (id),
  requested_at  timestamptz NOT NULL,
  decided_by    uuid        REFERENCES staff_users (id),
  decided_at    timestamptz,
  decision_note text,
  error         text,
  -- the second person can never be the first (only a withdrawal is the requester's own decision)
  CHECK (decided_by IS NULL OR decided_by <> requested_by OR status = 'withdrawn')
);
CREATE INDEX change_requests_open_idx ON change_requests (requested_at) WHERE status = 'pending' OR (mode = 'review' AND status = 'applied');
CREATE INDEX change_requests_target_idx ON change_requests (target_type, target_id, requested_at DESC);
-- One pending change per package at a time (two approved edits must not overwrite each other).
CREATE UNIQUE INDEX change_requests_one_pending_update ON change_requests (target_id) WHERE status = 'pending' AND kind = 'package.update';

CREATE TABLE support_notes (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES staff_users (id),
  body       text        NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX support_notes_user_idx ON support_notes (user_id, created_at DESC);

-- Finance read models: the latest paid invoice per subscription (MRR), money by time, subscriptions by time.
CREATE INDEX invoices_subscription_paid_idx ON invoices (subscription_id, period_end DESC) WHERE status = 'paid';
CREATE INDEX invoices_paid_at_idx ON invoices (paid_at);
CREATE INDEX invoices_refunded_at_idx ON invoices (refunded_at) WHERE refunded_at IS NOT NULL;
CREATE INDEX subscriptions_created_idx ON subscriptions (created_at);
CREATE INDEX subscriptions_ended_idx ON subscriptions (ended_at) WHERE ended_at IS NOT NULL;

ALTER TABLE playback_sessions ADD COLUMN provider_id uuid REFERENCES providers (id) ON DELETE SET NULL;
CREATE INDEX playback_sessions_report_idx ON playback_sessions (started_at, provider_id) WHERE access = 'package';

CREATE TABLE operator_guides (
  id                   uuid        PRIMARY KEY,
  name                 text        NOT NULL,
  url                  text        NOT NULL,
  url_hash             text        NOT NULL UNIQUE,
  host                 text        NOT NULL DEFAULT '',
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- lower first when two guides could serve the same channel automatically
  priority             integer     NOT NULL DEFAULT 100,
  generation           integer     NOT NULL DEFAULT 0,
  -- each sync run reserves its own generation (a run whose lease lapsed never touches the next one's rows)
  next_generation      integer     NOT NULL DEFAULT 0,
  sync_interval_hours  integer     NOT NULL DEFAULT 12,
  sync_status          text        NOT NULL DEFAULT 'queued' CHECK (sync_status IN ('idle', 'queued', 'running', 'failed')),
  sync_last_attempt_at timestamptz,
  sync_last_success_at timestamptz,
  sync_next_at         timestamptz,
  sync_error           text,
  sync_failures        integer     NOT NULL DEFAULT 0,
  -- asked to sync again while a run was in progress (new URL, new manual mapping)
  sync_rerun           boolean     NOT NULL DEFAULT false,
  lease_owner          text,
  lease_until          timestamptz,
  stats                jsonb       NOT NULL DEFAULT '{"channels":0,"programmes":0,"from":null,"to":null}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_guides_due_idx ON operator_guides (sync_status, sync_next_at);

CREATE TABLE operator_guide_channels (
  guide_id   uuid    NOT NULL REFERENCES operator_guides (id) ON DELETE CASCADE,
  generation integer NOT NULL,
  id         text    NOT NULL,
  names      text[]  NOT NULL DEFAULT '{}',
  icon       text,
  PRIMARY KEY (guide_id, generation, id)
);

CREATE TABLE operator_programmes (
  guide_id       uuid        NOT NULL REFERENCES operator_guides (id) ON DELETE CASCADE,
  generation     integer     NOT NULL,
  epg_channel_id text        NOT NULL,
  start_at       timestamptz NOT NULL,
  stop_at        timestamptz NOT NULL,
  title          text        NOT NULL,
  subtitle       text,
  description    text,
  categories     text[]      NOT NULL DEFAULT '{}',
  icon           text
);
CREATE INDEX operator_programmes_channel_idx ON operator_programmes (guide_id, generation, epg_channel_id, start_at);

CREATE TABLE channel_epg (
  channel_id     uuid        PRIMARY KEY REFERENCES channel_master (id) ON DELETE CASCADE,
  guide_id       uuid        NOT NULL REFERENCES operator_guides (id) ON DELETE CASCADE,
  epg_channel_id text        NOT NULL,
  method         text        NOT NULL CHECK (method IN ('auto', 'manual')),
  updated_at     timestamptz NOT NULL
);
CREATE INDEX channel_epg_guide_idx ON channel_epg (guide_id);
`,
    )
    .execute(db);
}
