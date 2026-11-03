# Commerce and playback authorization (ZP-ENT-07/08/09)

Phase 8 puts a paywall in front of operator channels without trusting the browser for anything:
money facts come from the payment processor, and every viewing of an operator channel is a
server-side **playback session** that is authorized, counted against the plan's stream limit,
re-checked on every heartbeat, and enforced again by the media proxy on every request.

**Gate:** no stream is issued without an active entitlement; concurrency and geo checks cannot be
bypassed.

```
viewer ──POST /operator/playback/sessions──► PlaybackAuthorizationService
            1 identity + registered device        (devices: key hash, plan limit)
            2 channel + rights (country, device class, time)
            3 entitlement (subscription / comp → package → business model) or FAST
            4 concurrency lease  streams:<user>  (Redis Lua | PostgreSQL)
            5 playback_sessions row (expires with the lease)
            6 plan: proxied links bound to grant {playback, sessionId}
            7 heartbeat every 30 s → re-authorize in the current country → renew lease
media proxy ── every manifest/segment ──► MediaGrantChecker: session live? (cached 30 s, forgotten on end)

processor ──webhook (HMAC)──► BillingService ──► subscriptions ──► entitlements ──► outbox
browser ◄── hosted checkout ──┘   (return page only *asks*; nothing is granted on redirect)
```

## Access model

| Mode (`OPERATOR_ACCESS`) | Operator channel plays when |
| --- | --- |
| `subscription` (default) | the account is not blocked, a **rights grant** covers the viewer's country / device class / now, and either the grant's business model is `fast` (free) or the viewer holds an active entitlement to a package that contains the channel **and** a grant covers that package's business model (`subscription` / `b2b`) |
| `rights` | Phase 6 behaviour: rights only (no paywall). Playback still goes through playback sessions (devices, stream limit) |

* **Entitlements** come from a subscription (mirrors it; `ends_at` = the subscription's
  `accessUntil`, so access ends on time even if the clock job lags) or from a **comp** grant made
  in the console (B2B, pilots, goodwill; optional end date, revocable, audited).
* **Limits** (`max_streams`, `max_devices`) are the most generous of the viewer's active packages;
  without one, `DEFAULT_MAX_STREAMS` / `DEFAULT_MAX_DEVICES` apply (FAST viewers, rights mode).
* A **retired** package is no longer sold but keeps serving everyone who already holds it.
* The channel list marks channels the viewer may not watch yet as `locked` with the packages
  (on sale) that unlock them; channels without rights for the viewer are not listed at all.
* `POST /api/v1/playback` refuses operator content in subscription mode
  (`PLAYBACK_SESSION_REQUIRED`); playlist exports, EPG and search never carry operator stream links.

## Subscription lifecycle (pure domain, `domain/commerce/subscription.ts`)

```
trialing ──payment──► active ──period ends unpaid──► past_due ──► grace ──► expired
   │                    ▲                               │           │
   │                    └─────────── payment ───────────┴───────────┘
   └─ trial ends unpaid ─► past_due ──(retry window only, never paid)──► expired
cancel at period end: access until the period end, then canceled
cancel now / refund / cancel while in dunning: canceled immediately
```

| Rule | Why |
| --- | --- |
| Time is an event (`tick`) applied by the clock job, webhooks and tests alike | one transition function, testable |
| A payment counts only if it extends the paid period | late, duplicated and out-of-order webhooks are harmless |
| Dunning: `DUNNING_PAST_DUE_DAYS` (3) then `DUNNING_GRACE_DAYS` (4), access kept | payment retries without cutting viewers off |
| An unpaid trial gets the past-due window only | no 7 free days of grace on top of a trial |
| Expiry by dunning → the processor is told to cancel (outbox) | nobody is charged after access ended |
| A payment that still lands on an ended subscription is refunded automatically (outbox) | the retry that raced the cancel |
| One trial per account, checked when the checkout starts **and** when the subscription is created (under an account lock) | two open trial checkouts cannot give two trials |
| One live subscription per account (partial unique index); a second paid checkout is voided — refunded and canceled at the processor (outbox) | two tabs, two payments |
| Refund of an older invoice does not end the current period | goodwill / dispute refunds |

## Payments

`PaymentProcessor` port: hosted checkout, signed webhooks, status queries (checkout, subscription),
cancel / resume, refund. Adapters: `fake` (built in, for development, tests and demos) and `none`
(no purchases; comp entitlements only). A real processor (Stripe, BOG, TBC…) is an adapter in
Phase 11.

* **Webhooks** `POST /api/v1/billing/webhooks/:processor` — raw body, signature verified
  (timing-safe), recorded in `payment_events` (unique per processor event id) and processed **in
  the same transaction**: a replay answers `duplicate`; a failure rolls the record back so the
  processor's retry is processed again.
* **Return page** `/billing/return?checkout=…` polls `GET /billing/checkout/:id`; when no webhook
  has completed it yet, the server asks the processor (`fetchCheckout`). Only a paid answer counts.
* **Reconciliation** (hourly): live subscriptions not compared for 6 h are synced with the
  processor's snapshot (skipped when they changed meanwhile); open checkouts older than 10 min are
  verified, abandoned ones expire after 24 h.
* **Fake processor**: hosted page `/billing/fake-checkout/:ref` (plain HTML forms, escaped, works
  under the CSP), webhooks HMAC-signed with `PAYMENT_FAKE_SECRET` and delivered asynchronously
  through the same entry point. State lives in one instance's memory: demos only. Refused in
  production unless `PAYMENT_ALLOW_FAKE_IN_PRODUCTION=true`.

## Devices and concurrency

* A device is a random key (≥ 32 chars) the client keeps; only its SHA-256 is stored.
  Registering the same key again returns the same device (a reload never takes another slot).
  Registration is serialized per account (advisory lock) against the device limit.
* Removing a device ends its viewings at once (links die at the proxy). The browser registers
  again on its next play if a slot is free — the device limit is the control, not the key.
* **Leases** (`LeaseStore`): key `streams:<userId>`, holder = playback session id, TTL 120 s
  (hidden tabs throttle timers to ~1/min), renewed by heartbeats every 30 s. Redis: one Lua script
  (purge expired, count, add) — atomic across instances; without Redis, PostgreSQL with a
  per-key transaction advisory lock and the database clock. Never per-instance memory.
* "Stop & watch here": `DELETE /operator/playback/sessions/:id` works for any of the account's
  sessions; the 409 `CONCURRENCY_LIMIT` lists what is playing where.
* Viewings end immediately (not at the next heartbeat) when: a rights grant is revoked, a channel
  leaves a package, a comp entitlement is revoked, staff cancel or block, a subscription loses
  access (outbox, within seconds). Each ends the session, releases the lease and forgets the
  proxy grant cache entry.

## API

Viewer (`/api/v1`, session required):

| Method | Path | |
| --- | --- | --- |
| GET | `/billing/packages` | plans on sale (with the trial this viewer would get) |
| POST | `/billing/checkout` | `{ packageId }` → `{ checkoutId, redirectUrl }` (accounts only) |
| GET | `/billing/checkout/:id` | `open` / `completed` / `expired` (+ subscription) |
| GET | `/billing/account?deviceId=` | subscription, entitlements, invoices, limits, devices, playing |
| POST | `/billing/subscription/cancel` · `/resume` | |
| GET · POST · DELETE | `/devices`, `/devices/:id` | list, register `{ key, name, platform }`, remove |
| POST | `/operator/playback/sessions` | `{ channelId, deviceId, secureContext, replaces?, continueSession? }` → session + plan |
| POST | `/operator/playback/sessions/:id/heartbeat` | 403 `NOT_ENTITLED` (reason) / 404 ended / 409 slot lost |
| DELETE | `/operator/playback/sessions/:id` | stop (this or another device of the account) |

Errors: `NOT_ENTITLED` (`no_subscription`, `not_in_package`, `account_blocked`, `territory`,
`device`, `not_licensed`, …), `CONCURRENCY_LIMIT`, `DEVICE_LIMIT`, `DEVICE_REQUIRED`,
`ACCOUNT_REQUIRED`, `ALREADY_SUBSCRIBED`, `PLAYBACK_SESSION_REQUIRED`.

Console (`/admin/v1`, audited): `GET/POST /packages`, `GET/PATCH /packages/:id` (`status`,
`channelIds`, prices for new checkouts) — `billing:*`; `GET /users/:id/billing`,
`POST /users/:id/entitlements` (comp), `DELETE /users/:id/entitlements/:id`,
`POST /users/:id/subscription/refund|cancel`, `GET /billing/payment-events` — `billing:*`;
`POST /users/:id/block` — `users:write`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `OPERATOR_ACCESS` | `subscription` | `rights` = no paywall (Phase 6 behaviour) |
| `PAYMENT_PROCESSOR` | `fake` (dev/test), `none` (production) | |
| `PAYMENT_FAKE_SECRET` | random per boot | webhook HMAC key of the fake processor |
| `PAYMENT_ALLOW_FAKE_IN_PRODUCTION` | `false` | public demos only |
| `DEFAULT_MAX_STREAMS` / `DEFAULT_MAX_DEVICES` | 1 / 5 | limits without a package |
| `DUNNING_PAST_DUE_DAYS` / `DUNNING_GRACE_DAYS` | 3 / 4 | |
| `GEO_STATIC_RANGES` | — | `GE=203.0.113.0/24,2001:db8::/32;DE=…` IP → country when the edge sends no country header (a GeoIP adapter replaces it later) |

Country resolution order: the edge header (`OPERATOR_COUNTRY_HEADER`) → `GEO_STATIC_RANGES` on the
client IP (`TRUST_PROXY` decides which IP) → `OPERATOR_DEFAULT_COUNTRY`.

## Jobs

| Job | Every | |
| --- | --- | --- |
| `subscription-clock` | 5 min | trial / period end, dunning, expiry |
| `billing-reconcile` | 1 h | processor snapshots, unfinished checkouts |
| `playback-sessions` | 1 min | close viewings whose heartbeats stopped, release their leases; purge expired PG leases |
| `cleanup` | 1 h | ended viewings and expired checkouts older than 90 days (invoices and payment events are kept) |

## Known limits

| Limit | Plan |
| --- | --- |
| Proxy links are still bearer URLs while their session lives: a link copied to another device plays there too (the session, not the device, is counted) | Phase 11: CDN tokens bound to client IP / session; DRM licenses per session |
| The device class used for rights is declared by the client | Attested apps (TV / STB) in Phase 11; until then, license web-only rights conservatively |
| Fake processor state is per instance | Real processor adapter (Phase 11) |
| Package price changes apply to new checkouts only | Processor-side plan migration (Phase 11) |
