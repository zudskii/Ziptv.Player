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

## Known gaps (accepted for now)

| Gap | Plan |
| --- | --- |
| Proxy links are bearer URLs: anyone a viewer shares a link with can watch until revocation/expiry | Phase 8: playback sessions with heartbeat + concurrency leases bind links to one playing device |
| Signed URLs cannot enforce subscription state mid-session | Phase 8 entitlement check on heartbeat |
| All proxied video flows through Node.js | Phase 11: CDN signed URLs; the proxy stays for BYO sources |
| MPEG-DASH cannot be proxied | DASH manifest rewriting or CDN delivery (Phase 11) |
| Catch-up templates are left out of `proxied` exports | Phase 10 catch-up through the proxy |
| `STREAM_TOKEN_SECRET` has no rotation list | Tokens live hours; rotate by deploying a new secret (in-flight streams re-plan) |
| Rolling deploy from the 2.x token format: links issued by old instances get 403 on new ones | Clients re-plan automatically on a fatal stream error |
| Deleting an account relies on the 30 s grant TTL (no explicit forget) | Acceptable; sessions are gone from the database immediately |
| `EXT-X-DEFINE` variable substitution is not supported (lines dropped in strict mode) | Rare in IPTV; expand variables if a provider needs it |
| Dev-only dependency advisories (vitest, tailwind's chokidar) | Major upgrades scheduled separately; CI gates production dependencies |
