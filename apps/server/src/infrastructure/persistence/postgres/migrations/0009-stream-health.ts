import { sql, type Kysely } from 'kysely';

/**
 * Stream health and failover (Phase 7, ZP-ENT-06).
 *
 *   feed_probe_state      one row per (feed, probe region): the region's state machine, schedule
 *                         and lease (probe workers of a region claim their own rows)
 *   stream_probe_results  every probe (time series; BRIN on time, pruned by retention)
 *   feed_health           the feed's overall state (regions combined) + operator maintenance
 *   channel_failover      which feed of a channel is active, operator pin (override)
 *   failover_events       the switch journal
 *   incidents             open → acknowledged → resolved, one open incident per (kind, target)
 *   playback_telemetry    5-minute buckets of real playback starts/errors per feed or BYO source
 *   source_probe_state    careful health checks of subscribers' own sources (schedule + lease)
 *
 * Retention is a batched DELETE by time (BRIN keeps it cheap). Range partitioning of the
 * probe table is deferred to Phase 13 (Scale), when volumes justify its operational cost.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
CREATE TABLE feed_probe_state (
  feed_id        uuid        NOT NULL REFERENCES channel_feeds (id) ON DELETE CASCADE,
  region         text        NOT NULL CHECK (region ~ '^[a-z0-9-]{1,40}$'),
  state          text        NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('HEALTHY', 'UNHEALTHY', 'GEO_BLOCKED', 'NOT_ENTITLED', 'UNKNOWN')),
  failures       integer     NOT NULL DEFAULT 0,
  successes      integer     NOT NULL DEFAULT 0,
  last_outcome   text,
  last_error     text,
  last_probe_at  timestamptz,
  last_ok_at     timestamptz,
  next_probe_at  timestamptz NOT NULL DEFAULT now(),
  -- live-window progress between probes
  media_sequence bigint,
  last_segment   text,
  sequence_at    timestamptz,
  last_decode_at timestamptz,
  lease_owner    text,
  lease_until    timestamptz,
  PRIMARY KEY (feed_id, region)
);
CREATE INDEX feed_probe_state_due_idx ON feed_probe_state (region, next_probe_at);
-- running probes (the per-provider concurrency check of every claim)
CREATE INDEX feed_probe_state_leased_idx ON feed_probe_state (lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX channel_feeds_provider_idx ON channel_feeds (provider_id);

CREATE TABLE stream_probe_results (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_id        uuid        NOT NULL REFERENCES channel_feeds (id) ON DELETE CASCADE,
  region         text        NOT NULL,
  probed_at      timestamptz NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('manifest', 'segment', 'stream', 'decode')),
  outcome        text        NOT NULL CHECK (outcome IN ('ok', 'degraded', 'stalled', 'unreachable', 'http_error', 'geo_blocked', 'not_entitled', 'invalid_media')),
  http_status    integer,
  ttfb_ms        integer,
  duration_ms    integer,
  bytes          integer,
  media_sequence bigint,
  error          text
);
CREATE INDEX stream_probe_results_feed_idx ON stream_probe_results (feed_id, probed_at DESC);
CREATE INDEX stream_probe_results_time_brin ON stream_probe_results USING brin (probed_at);

CREATE TABLE feed_health (
  feed_id          uuid        PRIMARY KEY REFERENCES channel_feeds (id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('HEALTHY', 'UNHEALTHY', 'GEO_BLOCKED', 'NOT_ENTITLED', 'MAINTENANCE', 'PROVIDER_OUTAGE', 'UNKNOWN')),
  since            timestamptz NOT NULL DEFAULT now(),
  maintenance      boolean     NOT NULL DEFAULT false,
  maintenance_note text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_health_status_idx ON feed_health (status);

CREATE TABLE channel_failover (
  channel_id     uuid        PRIMARY KEY REFERENCES channel_master (id) ON DELETE CASCADE,
  active_feed_id uuid        REFERENCES channel_feeds (id) ON DELETE SET NULL,
  pinned_feed_id uuid        REFERENCES channel_feeds (id) ON DELETE SET NULL,
  pinned_until   timestamptz,
  pinned_by      uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
  pin_note       text,
  last_switch_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE failover_events (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id   uuid        NOT NULL REFERENCES channel_master (id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL,
  -- plain ids: the journal outlives deleted feeds
  from_feed_id uuid,
  to_feed_id   uuid,
  reason       text        NOT NULL CHECK (reason IN ('initial', 'unhealthy', 'failback', 'pinned', 'unpinned', 'no_feed')),
  actor_id     uuid,
  actor_email  text,
  details      jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX failover_events_channel_idx ON failover_events (channel_id, occurred_at DESC);
CREATE INDEX failover_events_time_idx ON failover_events (occurred_at);

CREATE TABLE incidents (
  id              uuid        PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('feed_unhealthy', 'channel_down', 'provider_outage')),
  severity        text        NOT NULL CHECK (severity IN ('warning', 'critical')),
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  target_type     text        NOT NULL CHECK (target_type IN ('feed', 'channel', 'provider')),
  target_id       uuid        NOT NULL,
  title           text        NOT NULL,
  details         jsonb       NOT NULL DEFAULT '{}',
  opened_at       timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolved_by     uuid        REFERENCES staff_users (id) ON DELETE SET NULL
);
-- one live incident per problem: re-detection updates it instead of opening another
CREATE UNIQUE INDEX incidents_open_uniq ON incidents (kind, target_id) WHERE status <> 'resolved';
CREATE INDEX incidents_status_idx ON incidents (status, opened_at DESC);

CREATE TABLE playback_telemetry (
  subject_type   text        NOT NULL CHECK (subject_type IN ('feed', 'source')),
  subject_id     uuid        NOT NULL,
  bucket         timestamptz NOT NULL,
  starts         integer     NOT NULL DEFAULT 0,
  errors         integer     NOT NULL DEFAULT 0,
  startup_ms_sum bigint      NOT NULL DEFAULT 0,
  startup_count  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_type, subject_id, bucket)
);
CREATE INDEX playback_telemetry_bucket_idx ON playback_telemetry (bucket);

CREATE TABLE source_probe_state (
  source_id     uuid        PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  -- newest first, at most 5: [{ "ok": true, "latencyMs": 120, "at": "…" }]
  checks        jsonb       NOT NULL DEFAULT '[]',
  lease_owner   text,
  lease_until   timestamptz
);
CREATE INDEX source_probe_state_due_idx ON source_probe_state (next_check_at);
`,
    )
    .execute(db);
}
