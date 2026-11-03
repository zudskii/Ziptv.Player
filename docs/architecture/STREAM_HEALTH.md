# Stream health and failover (ZP-ENT-06)

Operator channels have several licensed feeds (primary and backups from different providers).
Phase 7 watches every feed and keeps each channel on a feed that works, without trusting a
single probe, a single location or a single viewer's report.

```
probe fleet (per region) ──► feed_probe_state (region state machine, hysteresis)
                                   │
                      HealthEvaluator (transaction)
                ┌──────────────────┼────────────────────────┐
           feed_health        channel_failover          incidents ──► outbox ──► webhook / Slack / email
     (regions combined,     (active feed, pin,        (feed / channel /
      maintenance, outage)   cooldown) + journal        provider)
                                   │
                    playback: active feed first, then working, then failing
```

## Probes: HTTP 200 is not enough

| Feed | Steps | Fails when |
| --- | --- | --- |
| HLS | playlist (→ the **cheapest** variant) → newest segment (first 1 MB) [+ init section] → decode check | error status, unparsable playlist, empty segment, the live window **stops moving** (media sequence unchanged for 3 target durations, at least 30 s), sample not decodable |
| MPEG-TS / progressive | first 1 MB of the stream | error status, not media (e.g. an HTML error page) |

* **TTFB** above 2 s marks a working feed `degraded` (counts as a success, recorded).
* **Decode check** (`PROBE_DECODE_EVERY_HOURS`, default 6 h): `ffprobe` on the downloaded sample
  through stdin only (`-protocol_whitelist pipe`) — a hostile playlist cannot make it fetch
  anything, so the upstream client's SSRF policy stays the only network path. A missing binary
  disables the check; a timeout is inconclusive (not a failure).
* Status classes: 451 / a 403 whose body mentions the location → `GEO_BLOCKED`; 401 / 403 →
  `NOT_ENTITLED` (credentials/contract); other errors, timeouts → `UNHEALTHY`.
* Every step is stored in `stream_probe_results` (time series, BRIN on time, pruned after
  `PROBE_RETENTION_DAYS`). Range partitioning is deferred to Phase 13 (Scale).

## States and hysteresis

Per region: `failAfter` consecutive failures (default 3) to fail, `recoverAfter` consecutive
successes (default 3) to recover. The first success of a new feed counts at once.

Overall (regions combined by consensus):

| Overall | When |
| --- | --- |
| `MAINTENANCE` | operator set it (planned work; the feed is never offered) |
| `HEALTHY` | **any** region that probed recently sees it healthy |
| `UNKNOWN` | no recent verdict |
| `NOT_ENTITLED` | a region is refused (credentials / contract) |
| `GEO_BLOCKED` | every failing region is geo-blocked |
| `PROVIDER_OUTAGE` | failing, and ≥ 50 % (min. 3) of the provider's feeds fail together — one provider incident instead of one per channel |
| `UNHEALTHY` | otherwise failing |

A failure seen from one location only is a network problem of that location, not of the feed:
it never causes a failover. Run probe workers in at least two regions (`PROBE_REGION` per
deployment, `PROBE_REGIONS` lists the expected ones; the console shows regions that never reported).

## Failover

Only between the licensed feeds of the **same** master channel (rights are checked for the channel
before playback).

| Situation | Decision | Journal |
| --- | --- | --- |
| first decision | preferred feed not known to fail | `initial` |
| active feed fails | best working feed, immediately | `unhealthy` |
| a preferred feed is healthy again | switch back only after `FAILOVER_COOLDOWN_MINUTES` since the last switch | `failback` |
| operator pin | the pinned feed, until released / `until` / the feed goes into maintenance | `pinned` / `unpinned` (with the operator) |
| nothing works | stay; the player still receives every feed | — (incident `channel_down`) |

Playback offers the active feed first, then working feeds before failing ones by priority (never
feeds in maintenance), so a viewer whose stream dies reconnects to a working feed with the next
plan. Decisions lock the channel's failover row and read the feeds after the lock; concurrent
evaluations of two feeds of one channel serialise. A periodic job (every minute) performs
fail-backs whose cooldown expired, releases expired pins and resolves incidents of targets that
left the catalog.

## Client telemetry

Every playback candidate carries an opaque token (HMAC; bound to the viewing's session id). The
player reports `start` (time to first frame) and `error` for **proxy** candidates — failed direct
attempts (CORS, mixed content) and codec errors describe the browser, not the stream. At most one
start and three errors per candidate and viewing count. Counts land in 5-minute buckets per feed /
BYO source.

Telemetry is client-reported and can be wrong or forged, so it **never switches a feed**: when ≥ 50 %
of ≥ 5 recent attempts on a feed fail, the feed is re-probed at once in every region, and the probes
decide.

## Incidents and alerts

| Kind | Severity | Opens | Resolves |
| --- | --- | --- | --- |
| `feed_unhealthy` | warning | a feed fails | it recovers / goes into maintenance / leaves the catalog |
| `channel_down` | critical | no working feed and at least one failing | a feed works again |
| `provider_outage` | critical | a provider's outage | the outage ends |

One live incident per (kind, target) — re-detection refreshes it. Operators acknowledge (or resolve
a false alarm) in the console; both are audited. Alerts are outbox messages, one per destination,
so a failing Slack hook is retried without re-sending the email:

* **Webhook** `ALERT_WEBHOOK_URL`: JSON `{ event, incident }`; `X-ZIPTV-Delivery: <id>:<event>`
  (de-duplicate on it — delivery is at least once) and `X-ZIPTV-Signature: sha256=<HMAC of the body>`
  with `ALERT_WEBHOOK_SECRET`.
* **Slack** `ALERT_SLACK_WEBHOOK_URL` (incoming webhook).
* **Email** `ALERT_EMAIL_TO` (comma-separated; needs SMTP).

## Subscribers' own sources (BYO)

Online / Slow / Unstable / Offline next to each source. Probing is careful: IPTV accounts allow
one or two connections, so ZIPTV never opens a stream to check a source. Evidence: the first 4 KB
of the playlist (Range) or the Xtream account call, every `SOURCE_HEALTH_INTERVAL_MINUTES`
(×4 while offline), only for accounts seen in the last 7 days — plus real playback telemetry
(failed plays in the last 6 hours).

## Capacity and configuration

* `PROBE_PROVIDER_CONCURRENCY` (default 1) is fleet-wide per provider: an account's connection
  limit applies wherever probes come from. A provider with N feeds needs roughly
  `N × probe time ≤ interval × concurrency`; with ~2 s probes and a 60 s interval that is ~30
  feeds per probe slot. Raise the concurrency (if the contract allows) or the interval for big
  providers, or its regions go stale and consensus degrades to fewer regions.
* `PROBE_CONCURRENCY` must stay below `DATABASE_POOL_MAX`.

| Variable | Default | |
| --- | --- | --- |
| `PROBES_ENABLED` | on (off in tests) | this instance probes (when it runs jobs) |
| `PROBE_REGION` / `PROBE_REGIONS` | `default` / — | this instance's location / the expected ones |
| `PROBE_INTERVAL_SECONDS` / `PROBE_FAILING_INTERVAL_SECONDS` | 60 / 20 | normal / while failing or recovering |
| `PROBE_CONCURRENCY` / `PROBE_PROVIDER_CONCURRENCY` | 4 / 1 | per instance / per provider, fleet-wide |
| `PROBE_DECODE_EVERY_HOURS`, `FFPROBE_PATH` | 6, `ffprobe` | decode checks (0 = off) |
| `HEALTH_FAIL_AFTER` / `HEALTH_RECOVER_AFTER` | 3 / 3 | hysteresis |
| `FAILOVER_COOLDOWN_MINUTES` | 10 | before failing back |
| `PROBE_RETENTION_DAYS` | 14 | probe history |
| `SOURCE_HEALTH_INTERVAL_MINUTES` | 30 | BYO checks |
| `ALERT_*` | — | see above |
| `METRICS_TOKEN` | — | `GET /metrics` (Prometheus) with `Authorization: Bearer …`; unset = disabled |

## Metrics (Prometheus)

`GET /metrics` on every instance (API and worker role): process/runtime, `ziptv_http_request_duration_seconds`
(by route pattern), `ziptv_probe_duration_seconds{region,outcome}`, `ziptv_failovers_total{reason}`,
`ziptv_incident_events_total{kind,event}`, `ziptv_playback_telemetry_total`, `ziptv_playback_plans_total`,
and database-backed gauges `ziptv_feeds{state}`, `ziptv_incidents_open{kind}` (cached 10 s).

## Console API (`/admin/v1/monitoring`)

| Endpoint | Permission |
| --- | --- |
| `GET /monitoring/feeds?status&channelId&providerId`, `GET /monitoring/feeds/:id/probes` | `monitoring:read` |
| `POST /monitoring/feeds/:id/probe`, `POST /monitoring/feeds/:id/maintenance` | `monitoring:operate` |
| `GET /monitoring/channels/:id/failover` (state + journal) | `monitoring:read` |
| `POST /monitoring/channels/:id/failover/pin`, `DELETE …/pin` | `monitoring:operate` |
| `GET /monitoring/incidents?status`, `POST /monitoring/incidents/:id/acknowledge`, `…/resolve` | `monitoring:read` / `monitoring:operate` |

Every write is audited in its transaction; pins are also journaled with the operator.
