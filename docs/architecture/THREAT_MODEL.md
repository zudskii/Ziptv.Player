# ZIPTV — Threat model (Phase 1 baseline)

Scope: the control plane in `apps/server` and how it hands media to clients. Out of scope until
their phases: payments (Phase 8/11), DRM (Phase 11), admin console (Phase 2/9).

## Assets

| Asset | Why it matters |
| --- | --- |
| Provider credentials and stream URLs (often `…/user/pass/…` or `?token=`) | Leaked → the provider account is resold/abused, concurrency limits blown, contract breached |
| Request headers for upstreams (User-Agent, Referer, Cookie) | Same as above; some panels authenticate by header |
| Bearer session tokens | Account takeover |
| Export links | Anyone holding one can stream through ZIPTV |
| `STREAM_TOKEN_SECRET`, `DATA_ENCRYPTION_KEY` | Forge media tokens / decrypt every stored secret |

## Delivery modes

| | `STREAM_DELIVERY=auto` (default) | `STREAM_DELIVERY=proxy` |
| --- | --- | --- |
| Intended for | A user's own sources (BYO) | Operator / licensed content |
| Playback candidates | direct first when the browser can fetch it, proxy as fallback | proxy only |
| Artwork | stored URL (client falls back to the image proxy) | image-proxy path only |
| Export links | `direct` (default) | `proxied` (default) or `off`; `direct` is rejected at boot |
| Web-page entries | link returned so the user can open it | link withheld |
| CSP of the served client | media/img/connect `*` | `'self'` only |
| MPEG-DASH | direct only | not deliverable yet (DASH manifests are not rewritten) |

## Controls

**Media tokens** (`infrastructure/crypto/media-token.ts`) — `2<base64url(salt | AES-256-GCM(json) | tag)>`.
Each token is encrypted under its own key, HKDF(`STREAM_TOKEN_SECRET`, salt), where the salt is
an HMAC of the plaintext (SIV-style): a nonce is never reused with a different plaintext, however
many segment links are issued. The upstream URL and headers are encrypted, so a proxy link
reveals nothing; GCM authentication prevents forging/tampering. Identical inputs give identical
tokens — required because players match HLS init sections and keys by URL across playlist
refreshes — and the same artwork URL keeps one token for 30 days (CDN cache).

**Grants and revocation** (`application/playback/media-grants.ts`) — every stream token names
what keeps it alive: the signed-in *session* that asked for the playback plan, or the *export*
link it was written into. The proxy re-checks the grant (decision cached 30 s). Signing out,
deleting a device, replacing or turning off an export link stop the streams immediately on the
instance that handled it and — through cache invalidation over Redis — on every instance.

**Token lifetimes** — top-level stream links: `STREAM_TOKEN_TTL_SECONDS` (default 6 h). Inside a
proxied live HLS playlist, segment/key/part links live 10–15 minutes (expiry bucketed so refreshes
keep identical URLs); playlists and init sections keep the plan's lifetime. VOD playlists keep long segment links (a movie is
fetched over hours). Export links: `PLAYLIST_EXPORT_LINK_TTL_HOURS` (default 7 days).
Expiry is a backstop; revocation is the grant check.

**Manifest hygiene** — in `proxy` delivery, proxied HLS playlists keep only rewritten URIs:
free-text comments, `EXT-X-DEFINE`, and any line still holding an absolute URL (session data,
date-range asset lists, unparsable URIs) are dropped.

**Error hygiene** — proxy errors never include upstream hosts or addresses (details go to debug
logs). Logs redact tokens, passwords, credentials and locators; access logs replace media and
export tokens with `[token]`.

**SSRF** — every outbound request goes through `UpstreamClient`: http(s) only, literal private
IPs refused, the resolved address checked again at connect time (DNS rebinding), each redirect
hop re-validated, cookies/authorization dropped on cross-origin redirects, size caps and
timeouts. `ALLOW_PRIVATE_UPSTREAMS` only for home servers.

**Shared state** (`REDIS_URL`) — rate limits (including login/password-reset brute-force
budgets), cache invalidation and leases are shared across instances. Without Redis each
instance counts alone: N replicas allow N× the budget. If Redis is unreachable (at boot or
later) limiters fall back to per-instance memory for a few seconds at a time — limits stay
enforced and requests never fail because of Redis. `REDIS_KEY_PREFIX` namespaces keys and
channels (staging and production may share a Redis). Grant decisions live in their own cache so
many concurrent streams cannot evict catalog caches.

**Proxied exports** need `PUBLIC_URL` in production: stream URLs written into a playlist are
absolute and must not be derived from request headers.

## Operator console (Phase 2)

- **Separate identities**: staff accounts (`staff_users`) are not subscriber accounts; a stolen
  viewer login never reaches the console. Passwords are scrypt hashes; temporary passwords must be
  replaced (≥ 12 chars) before any permissioned route works.
- **MFA always**: a password alone never yields a session. TOTP (RFC 6238) secrets are encrypted at
  rest; each code is accepted once (atomic `mfa_last_step` claim — no replay, even across
  instances). Sign-in challenges are encrypted, expire after 5 minutes and are rate limited
  (per IP, per email, per challenge).
- **Separate listener**: `/admin/v1` exists only on `ADMIN_PORT` (own origin, strict `'self'`
  CSP, no CORS, `no-store`). docker-compose binds it to loopback.
- **Sessions**: SHA-256-hashed tokens, 30 min idle / 12 h absolute; disabling a member, changing
  their role, resetting their 2FA or password signs out their sessions.
- **RBAC**: permissions per role in `domain/admin/rbac.ts`; every route declares its access and
  the router enforces it (a test walks all routes: 401 without a session, 403 without the permission).
- **Audit**: the change, its audit entry and its outbox messages commit in one transaction. The log
  is append-only (trigger refuses UPDATE/DELETE/TRUNCATE) and hash-chained under an advisory lock,
  so even a superuser edit is detectable (*Verify integrity*). Anchoring the head hash outside the
  database (e.g. daily to object storage) is a later hardening step.

Known gaps: no recovery codes (another super admin or the CLI `recover` resets a lost
authenticator); no four-eyes approval yet (Phase 9 for rights/prices); the last-super-admin guard
is not race-proof against two simultaneous demotions (both actors would need to be super admins).

## Stream health (Phase 7)

- **Probes reach providers only through the upstream client** (SSRF policy on every hop,
  timeouts, size caps). The decode check runs `ffprobe` on bytes ZIPTV already downloaded, through
  stdin only (`-protocol_whitelist pipe`): a hostile playlist cannot make it open URLs or files.
- **Provider etiquette**: at most `PROBE_PROVIDER_CONCURRENCY` probes per provider across the whole
  fleet (an IPTV account's connection limit), cheapest variant, first 1 MB of a segment; BYO
  sources are never probed with a stream (playlist head / account call only).
- **Client telemetry cannot steer delivery**: reports carry an HMAC token bound to the viewing's
  session, are capped per viewing and rate limited, and only trigger re-probes — probes decide.
- **Alerts and metrics carry no secrets**: incident titles/details name channels and providers,
  never upstream URLs or credentials; webhooks are HMAC-signed (`X-ZIPTV-Signature`) and carry an
  idempotency key; `/metrics` answers only with `METRICS_TOKEN` (404 when unset).

## Commerce and playback authorization (Phase 8)

- **Nothing is granted on the browser's word**: returning from the checkout page only makes the
  server ask the processor; subscriptions change only from signature-verified webhooks (raw body,
  timing-safe HMAC), processor status queries and the clock. Webhooks are recorded once
  (`payment_events` unique) in the same transaction as their effect.
- **Every operator viewing is authorized server-side** (device, rights for the current country,
  entitlement, concurrency lease) and re-authorized on every heartbeat; proxy links carry a
  `playback` grant that dies with the session (checked on every request, cache forgotten on end).
  The plain playback endpoint refuses operator content in subscription mode.
- **Concurrency cannot be raced**: the lease is one atomic operation (Redis Lua, or a PostgreSQL
  advisory lock per account key) with the store's own clock; device registration is serialized
  per account.
- **No IDOR**: checkouts, devices and playback sessions are looked up by id *and* owner; another
  account's id answers 404.
- **Device keys** are random secrets kept by the client; only their SHA-256 is stored.
- **Money mistakes are reversed automatically**: a second paid checkout, a reused trial, or a
  payment after the subscription ended are refunded and canceled at the processor (outbox).
- **The fake processor is refused in production** unless explicitly allowed for a demo.

## Console four-eyes and read models (Phase 9)

- **Prices, packages and rights grants need a second person** with the same write permission;
  nobody decides on their own request (domain rule and database `CHECK`). The change is re-applied
  in the approver's transaction after a stale check; requests expire after 30 days.
  `CONSOLE_FOUR_EYES=false` is refused in production.
- **Rights revocations apply at once** (a licence that ended must stop immediately) and are
  reviewed afterwards by a second person.
- **Account takeover inside the console**: an approver whose TOTP was enrolled after the request
  cannot decide on it, so a password + MFA reset of a colleague does not yield a second approver.
- **No side doors**: a channel merge is refused while the merged-away channel holds active rights
  or package membership.
- **Least privilege on read models**: revenue on the overview only with `billing:read`; the staff
  roster on the security screen only with `staff:read`; partner CSV cells are neutralised against
  spreadsheet formula injection; support note text never enters the audit trail.
- **CSP** of the console allows `img-src https:` (channel and provider logos are remote images);
  scripts, styles and connections stay `'self'`.

## Tests that enforce this

- `api/security.e2e.test.ts` — with proxy delivery, scans every response body/header a client
  received (channel lists, playback plans, proxied manifests, playlist entries, exported
  playlist, error bodies) and the debug logs for the provider host, path credentials, query
  token and User-Agent; checks live vs VOD link lifetimes, logout and export revocation, export
  `off`, configuration guards, and (with Redis) a shared login budget across two instances.
- `infrastructure/media/playback-units.test.ts` — token encryption, tamper/legacy rejection,
  HLS URI roles.
- `infrastructure/http/upstream-client.test.ts` — SSRF and redirect rules.
- `infrastructure/redis/shared-state.test.ts` — lease contract (memory + Redis), cross-instance
  rate limit and invalidation.
- `api/health.e2e.test.ts` — failover, pins, incidents, signed alerts, telemetry token binding and
  caps, metrics token, no upstream address in alerts/metrics.
- `api/commerce.e2e.test.ts` — the Phase 8 gate: no subscription / expired subscription / wrong
  country / revoked rights / removed device / blocked account / refund → no stream (heartbeat and
  proxy), concurrent starts against the stream limit, device limit, forged and replayed webhooks,
  success redirect without payment, duplicate payment and payment-after-end refunds, trial once.
- `infrastructure/persistence/postgres/lease-store.test.ts` — 12 concurrent acquires, limit 2.
- `api/console.e2e.test.ts` and `domain/admin/change-requests.test.ts` — four-eyes: requester
  cannot approve, wrong role cannot decide, stale and expired requests fail without applying, one
  pending price change per package, revocation review, merge refused with active rights, MFA
  re-enrolment rule, finance cannot see the staff roster.
- `apps/admin/src/roles.ui.test.tsx` — the console per role in a browser DOM against the real
  server: visible sections match the permissions and no screen calls an API that answers 401/403.

## Known gaps (accepted for now)

| Gap | Plan |
| --- | --- |
| Operator proxy links are bearer URLs while their playback session lives (Phase 8 ends them with the session, but a copied link plays elsewhere meanwhile) | Phase 11: CDN tokens bound to client IP / session, DRM licenses per session |
| The device class behind device-class rights is declared by the client | Attested TV / STB apps (Phase 11) |
| All proxied video flows through Node.js | Phase 11: CDN signed URLs; the proxy stays for BYO sources |
| MPEG-DASH cannot be proxied | DASH manifest rewriting or CDN delivery (Phase 11) |
| Catch-up templates are left out of `proxied` exports | Phase 10 catch-up through the proxy |
| A SUPER_ADMIN can create a fresh staff account and approve their own change with it | Staff creation under four-eyes or an external IdP (Phase 12) |
| `STREAM_TOKEN_SECRET` has no rotation list | Tokens live hours; rotate by deploying a new secret (in-flight streams re-plan) |
| Rolling deploy from the 2.x token format: links issued by old instances get 403 on new ones | Clients re-plan automatically on a fatal stream error |
| Deleting an account relies on the 30 s grant TTL (no explicit forget) | Acceptable; sessions are gone from the database immediately |
| `EXT-X-DEFINE` variable substitution is not supported (lines dropped in strict mode) | Rare in IPTV; expand variables if a provider needs it |
| Dev-only dependency advisories (vitest, tailwind's chokidar) | Major upgrades scheduled separately; CI gates production dependencies |
