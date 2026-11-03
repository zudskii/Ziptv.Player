# Operator console (Phase 9)

The console (`apps/admin`, API `/admin/v1` on the separate admin listener) is where staff run the
service. Phase 9 adds the screens 9.1–9.10 on top of the Phase 2 foundation (staff accounts,
password + TOTP, RBAC, tamper-evident audit trail). Three rules hold everywhere:

1. **The API decides, the UI follows.** Every route declares its permission
   (`AdminRouter`); the sidebar and buttons only hide what the API would refuse anyway. A browser
   test per role (`apps/admin/src/roles.ui.test.tsx`) asserts each role sees exactly its sections
   and that the screens it can open make **no** call that answers 401/403.
2. **Every write is audited** in the same transaction (`AdminUnitOfWork`). Support note bodies and
   secrets are never copied into audit details.
3. **Money and rights need two people** (four-eyes, below).

## Screens and permissions

| Screen | Route | Needs | Writes need |
| --- | --- | --- | --- |
| 9.1 Overview | `/` | `system:read` | — (revenue tiles only with `billing:read`) |
| Approvals | `/approvals` | `system:read` | the kind's write permission, not one's own request |
| 9.4 Live monitoring | `/monitoring` | `monitoring:read` | `monitoring:operate` (pin / unpin, incidents) |
| 9.2 Channels (+ review queue, duplicates, categories, lineups) | `/channels` | `catalog:read` | `catalog:write`; rights `rights:write` |
| 9.3 Providers (contract, SLA, cost) | `/providers` | `providers:read` | `providers:write` |
| 9.7 EPG (guides, coverage, mapping) | `/epg` | `catalog:read` | `catalog:write` |
| 9.6 Packages & rights | `/packages` | `billing:read` | `billing:write` |
| 9.5 Subscribers & billing | `/users` | `users:read` | `users:write` / `billing:write` |
| 9.8 Support & incidents | `/support` | `support:read` | `support:write` |
| 9.10 Finance & partners | `/finance` | `billing:read` | — |
| 9.9 Audit & security | `/audit` | `audit:read` | — (staff roster only with `staff:read`) |
| Staff | `/staff` | `staff:read` | `staff:write` |

Roles (code, `domain/admin/rbac.ts`): SUPER_ADMIN (all), CONTENT_MANAGER, NOC_OPERATOR,
SUPPORT_AGENT, FINANCE, VIEW_ONLY. FINANCE has `catalog:read` because packages are built from
channels.

## Four-eyes control (9.6)

| Change | Mode | Decided by |
| --- | --- | --- |
| `package.create`, `package.update` (price, period, limits, status, channels…) | **approval**: nothing changes until a second person approves | another holder of `billing:write` |
| `rights.grant` | **approval** | another holder of `rights:write` |
| `rights.revoke` | **review**: applied at once (an ended licence must not wait), then reviewed by a second person | another holder of `rights:write` |

* `POST /packages`, `PATCH /packages/:id`, `POST /channels/:id/grants` answer **202
  `{changeRequest}`** when the change waits for approval (201/200 with the entity only when
  four-eyes is off).
* **Nobody decides on their own request** (domain rule + a database `CHECK decided_by <>
  requested_by`). The requester can only withdraw a pending request.
* **Approval re-applies the change inside the approver's transaction**, after re-reading the
  target under lock: if it changed since the request (package state hash; for rights, the set of
  revoked grants on the channel) the request becomes `failed` — visibly, nothing applied.
  Requests older than **30 days** expire the same way.
* **One pending change per package** (partial unique index), so two price changes cannot race.
* **Re-enrolled accounts cannot be the second person**: an approver whose TOTP was enrolled after
  the request was made is refused (an admin who resets a colleague's password + MFA must not be
  able to approve as them).
* **No bypass through other screens**: a channel merge is refused while the merged-away channel
  has active rights grants or package membership — those are revoked / changed through the flows
  above first.
* Decisions are audited (`change.requested / approved / rejected / withdrawn / failed /
  awaiting_review / reviewed`); the applied change is audited separately with the approver as
  actor and the requester in the details.
* `CONSOLE_FOUR_EYES` (default `true`) is refused as `false` in production. With it off (tests,
  single-person demos) changes apply immediately and are still recorded as `applied` requests
  with the note `four-eyes disabled`.

## Read models

All in `PgConsoleQueries` (SQL aggregates, no per-row loops); the console service shapes them.

* **Overview** — viewers playing now (live playback sessions), channels by health, open approvals;
  MRR and period revenue only for `billing:read`.
* **Finance** — MRR from the latest *paid* invoice of each active subscription (yearly ÷ 12);
  new / churned / active-at-start counted only for subscriptions that were ever paid (an abandoned
  checkout is neither won nor lost); revenue, refunds, net per currency; per package; a 12-month
  series (one query per measure). Ranges are limited to two years.
* **Partner report** — each package's net revenue in the period is split between providers by the
  **minutes watched** on their feeds (`playback_sessions.provider_id`, recorded at session start;
  minutes clipped to the period and to the last heartbeat + 30 s). Revenue of packages nobody
  watched is shown as *unattributed*; viewings without a known provider as *Unknown provider*.
  CSV export (cells neutralised against formula injection). Ended playback sessions are kept
  **400 days**, so the report cannot start earlier than that.
* **Provider report** — feeds by health, availability from probes over min(30 days, probe
  retention) against the contract's SLA target, contract dates and monthly cost.
* **Duplicates** — channels grouped by normalized name.
* **Security** — failed sign-ins (24 h count and latest), staff MFA / lock / sessions (roster
  only with `staff:read`).
* **Support notes** — internal notes on a subscriber (`support_notes`), written with
  `support:write`; the audit entry records that a note was added, not its text.

## Operator EPG (9.7)

* **Guides**: licensed XMLTV URLs (SSRF policy checked, stored sealed like source credentials),
  priority, sync interval. A sync worker (`operator-epg-sync`, lease) loads a guide into a new
  *generation* and switches over atomically; a "sync now" during a running sync is remembered and
  runs right after (`sync_rerun`).
* **Mapping**: every 10 minutes master channels are matched to guide channels by their aliases
  (tvg-id first, then normalized name; the guide with the lower priority number wins). A manual
  mapping in the console always wins; clearing it returns the channel to automatic.
* Only programmes of channels the catalog can use are kept.
* **Coverage** per channel: `unmapped`, `no_data`, `gaps` (a hole over 1 h in the next 24 h),
  `ends_soon` (data for less than 12 h), `ok`.
* **Viewers**: `GET /api/v1/operator/guide?channels=` — now / next, only for channels in the
  viewer's own authorized list.

## Known limits

| Limit | Plan |
| --- | --- |
| A SUPER_ADMIN can still create a second staff account and approve with it (the MFA rule stops reuse of an *existing* colleague's account) | Staff creation itself under four-eyes, or an external IdP with its own approval (Phase 12) |
| Partner split is by watch minutes only; minimum guarantees and per-contract rates are not modelled | Contract terms per provider when real licences are signed (Phase 11) |
| Finance reads run on the primary database | Read replica / reporting schema (Phase 13) |
| Duplicate detection is by normalized name only | Logo / tvg-id similarity (later) |
