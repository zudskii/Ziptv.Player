# ZIPTV Player (3.x architecture)

TypeScript/React IPTV player with anonymous sessions, M3U file/URL sources, live-channel catalog,
stream playback planning, proxying and background source synchronization.

## Workspace

| Directory | Responsibility |
| --- | --- |
| `apps/server/src/api` | Express 5 API, middleware, route validation |
| `apps/server/src/application` | Use cases and repository/transport ports |
| `apps/server/src/domain` | Domain rules and identifiers |
| `apps/server/src/infrastructure` | PostgreSQL adapters (`persistence/postgres`), parsers, media proxy, network/crypto implementation |
| `apps/server/src/container.ts` | Dependency-injection composition root |
| `apps/client/src` | React 19 + Vite 7 UI |
| `packages/contracts` | Shared types-only API contract (no runtime build) |

The production HTTP entry point is `apps/server/src/main.ts`, which imports `api/app.ts`.
The old `src/app.ts`, `src/modules` and old client playlists/watch implementation were
superseded during the 3.x migration and have been removed from the active source tree.
Old `/watch/:playlistId?/:channelKey?` links still redirect to `/live/...` in `app/App.tsx`.

## Start using Docker Compose

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` and **two different, permanent** secrets: `STREAM_TOKEN_SECRET` and `DATA_ENCRYPTION_KEY`.
   Generate each with `openssl rand -base64 48`. Both are required in production.
   In particular, changing an existing encryption key without a key-rotation plan
   makes previously stored provider credentials unreadable.
3. Run `docker compose up -d --build`.
4. Open `http://localhost:8080` (or the configured `PORT`).

Compose provisions PostgreSQL 17 (data in the `pg-data` volume) and a combined API/UI container.
Schema migrations run automatically at boot. If deploying on Render, set `DATABASE_URL` and keep
the generated secrets stable across redeploys. If replacing an
existing instance, reuse its `DATA_ENCRYPTION_KEY`, not a newly generated one.

## Local development

Requires Node.js 22 (see `.nvmrc`) and PostgreSQL 14+ (`docker compose up -d postgres` is enough).

```sh
npm ci
cp apps/server/.env.example apps/server/.env
# Configure DATABASE_URL in apps/server/.env
npm run migrate -w @ziptv/server     # optional: the server also migrates at boot
npm run dev:server
# In another terminal:
npm run dev:client
```

```sh
npm run build       # server TypeScript + client TypeScript and Vite production bundle
npm run typecheck   # server + client TypeScript validation
npm run lint        # ESLint
npm test            # unit tests; repository + e2e tests also run when TEST_DATABASE_URL is set
                    # e.g. TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
                    # (every test gets its own throw-away database on that server)
                    # shared-state (Redis) tests also run when TEST_REDIS_URL is set,
                    # e.g. TEST_REDIS_URL=redis://localhost:6379/0
```

For local work, use `npm ci` rather than copying `node_modules` from another OS.
Native Rollup/esbuild packages are platform-specific.

## HTTP API (`/api/v1`)

| Endpoint | Description |
| --- | --- |
| `POST /sessions`, `GET /sessions/me` | Guest session (anonymous device identity) and who am I |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` | Email + password account; see *Accounts* below |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Signed-in devices; sign one out |
| `POST /auth/password`, `DELETE /auth/account` | Change password; delete the account and its data |
| `GET /auth/features`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/verify-email`, `POST /auth/send-verification` | Email links; see *Email* below |
| `/playlists` (+ `/groups`, `/entries`, `/merge`, `/renumber`, `/relink`, `/export`) | The user's editable playlists; see *Playlists* below |
| `GET /p/<token>.m3u` | **Public** export link of a playlist (no session; the token is the credential) |
| `GET /sources`, `POST /sources`, `POST /sources/upload` | List/add M3U or Xtream sources |
| `GET/PATCH/DELETE /sources/:sourceId` | Source details/maintenance |
| `POST /sources/:sourceId/sync` | Queue source synchronization |
| `POST /sources/:sourceId/file` | Replace uploaded source data |
| `POST /sources/:sourceId/convert-to-xtream` | Switch an Xtream `get.php` M3U link to the Xtream API (keys kept) |
| `GET /live/:sourceId/channels` | Live catalog with ETag revalidation |
| `GET /live/:sourceId/channels/:key` | Channel details |
| `GET /vod/:sourceId/{movies,series}[/overview]` | Paged VOD lists (`category`, `sort`, `cursor`) and per-source rails + categories |
| `GET /vod/:sourceId/movies/:key`, `GET /vod/:sourceId/series/:seriesKey` | Details with My List / progress / resume (Xtream episodes load on first open) |
| `GET/POST /profiles`, `PATCH/DELETE /profiles/:id` | Profiles of the account; send `X-Profile-Id` to act as one |
| `GET /home`, `GET /search?q=` | Every Home rail in one response; unified search |
| `/me/list`, `/me/progress`, `/me/history`, `/me/settings`, `/me/storage`, `/me/data/:kind`, `/me/import-local` | The active profile's My List, Continue Watching, History, Settings, Data & Storage |
| `POST /playback` | Playback candidates and signed proxy URLs |
| `POST /playback/events` | Playback event reporting |
| `GET /notifications`, `POST /notifications/read`, `DELETE /notifications/:id` | Notifications |
| `GET /media/stream/:token` | Signed media proxy |
| `GET /media/images/:sourceId/:type/:key` | Catalog image proxy |

API requests generally use `Authorization: Bearer <token>`, except public session creation
and media token/image endpoints. Consult `apps/server/src/api/routes` and
`packages/contracts` for the exact request/response shapes.

### Configuration

`apps/server/.env.example` has the local server defaults. In production, the mandatory values
are `DATABASE_URL`, `STREAM_TOKEN_SECRET` and `DATA_ENCRYPTION_KEY`.
Source limits are `MAX_SOURCE_BYTES`, `MAX_ENTRIES_PER_SOURCE`, and `MAX_SOURCES_PER_USER`.
For compatibility, the config parser still accepts the former `MAX_PLAYLIST_*` variables.

### Delivery and shared state

| Variable | Values | Meaning |
| --- | --- | --- |
| `STREAM_DELIVERY` | `auto` (default) / `proxy` | `proxy`: upstream URLs, credentials and headers never reach a client — proxy-only playback, proxied artwork, strict CSP. Use it for operator/licensed content. |
| `PLAYLIST_EXPORT_MODE` | `direct` / `proxied` / `off` | Export links write upstream URLs, ZIPTV proxy URLs bound to the link (revocable), or are disabled. Defaults to `proxied` with `STREAM_DELIVERY=proxy`. |
| `REDIS_URL` | `redis://…` | Required once more than one instance runs: rate limits (login brute force), cache invalidation and leases become shared. `REDIS_KEY_PREFIX` (default `ziptv:`) namespaces keys. |
| `PUBLIC_URL` | `https://…` | Required in production when exports are `proxied` (absolute stream URLs in exported playlists). |

Stream proxy links are encrypted (the provider is not readable from them) and tied to the device
session or export link that obtained them; signing out or revoking the export link stops them.
Details and remaining gaps: `docs/architecture/THREAT_MODEL.md`.

`VITE_API_URL` selects the API origin for a separately hosted client. Leave it empty for
the single-origin Docker image. Set `ALLOW_PRIVATE_UPSTREAMS=true` only for trusted local
home-network deployments, not for a public server.

## Programme guide (EPG)

Guides are XMLTV URLs. A playlist's `url-tvg`/`x-tvg-url` attaches automatically; users can add
more under **Sources → TV guides** and map a channel by hand when automatic matching misses it.

```
XMLTV URL → download (gzip by magic bytes, size cap, SSRF policy, URL encrypted at rest)
          → SAX parse (any encoding, constant memory)
          → channel matcher: manual mapping ▶ tvg-id / Xtream epg id ▶ normalised name
          → PostgreSQL: programmes only for linked channels, archive days back … EPG_DAYS_AHEAD forward
          → /api/v1/epg/{now,channels/:sourceId/:key,guide,search,guides,mappings}
          → channel rows (LIVE now + progress + next), now card, mini guide, TV Guide grid
```

The `epg-sync` worker refreshes each guide every `EPG_SYNC_INTERVAL_HOURS` (lease-based, safe on
many instances; every run writes its own generation and swaps atomically). A guide that fails
shows "EPG unavailable"; live playback is unaffected.

## Xtream Codes sources

```
player_api.php: auth (user_info → account status, expiry, connections, trial; auth 0 → "Authentication failed")
              → live / VOD / series categories + lists (one list in memory at a time, size-capped)
              → catalog revision: live (HLS if allowed, else MPEG-TS; tv_archive → catch-up days),
                movies (container extension), series (episodes NOT fetched during the sync)
GET /vod/:sourceId/series/:key → get_series_info once → episodes stored into the same revision
POST /playback → stream URL built at play time from the encrypted account (never stored, never
                 sent to the client in proxy delivery)
```

- Keys of live channels and movies are computed exactly like an M3U import of the same panel's
  `get.php` (name + primary category, same order), so **Switch to Xtream** on an M3U source keeps
  favourites, history and progress. The switch first checks that `player_api.php` accepts the
  account; if it does not, the M3U link is kept.
- Live-only accounts whose panel errors on VOD/series actions still sync; a VOD/series list over
  twice `MAX_SOURCE_BYTES` is skipped with a warning instead of failing the sync.
- A series the provider returns without episodes is asked again after 10 minutes.

## Profiles and viewer state

Every account has a default profile; others are chosen with `X-Profile-Id` (an unknown id is a
404 — never a fallback to someone else's data). Kids profiles never see adult content.
My List, Continue Watching, History and Settings are per profile and keyed by stable catalog keys,
so they survive syncs; removing a source removes its user state (`ON DELETE CASCADE`).

```
POST /playback        → history row (id = playback session id)
POST /playback/events → start (no credit) · heartbeat/stop (time since last event, ≤ 60 s)
                        movie/episode position → progress: ignored < 30 s, completed near the end
reconnect             → `continueSession` keeps the same viewing (one history entry)
```

History older than the profile's retention (default 180 days) and zapping leftovers (< 10 s)
are pruned by the hourly cleanup job. Search matches the start of every word of a name
(`pg_trgm`-indexed `search` columns on channels, movies, series and programmes).

## Operator console (`apps/admin`)

Staff accounts are separate from subscriber accounts and always sign in with a password **and** a
TOTP code (authenticator app; enrolment happens at first sign-in). The console and its API
(`/admin/v1`) run on a **separate listener** — `ADMIN_PORT` (default 8081), i.e. a different origin
from the public app. The public port has no admin routes at all. docker-compose publishes the
console on `127.0.0.1` only: reach it through SSH/VPN, never the open internet.

```sh
# First super administrator (prints a one-time temporary password):
npm run staff -w @ziptv/server -- create --email ops@example.com --name "Ops"
docker compose exec app node server/cli/staff.js create --email ops@example.com --name "Ops"   # in Docker
# Locked out (lost authenticator): new temporary password + 2FA reset
npm run staff -w @ziptv/server -- recover --email ops@example.com
# Develop the console UI (proxies /admin/v1 to :8081)
npm run dev:admin
```

Roles: `SUPER_ADMIN`, `CONTENT_MANAGER`, `NOC_OPERATOR`, `SUPPORT_AGENT`, `FINANCE`, `VIEW_ONLY`.
Permissions per role live in `apps/server/src/domain/admin/rbac.ts`; every admin route declares its
permission and the server enforces it. Every change (and every sign-in, failed sign-in and support
action) is written to an append-only, hash-chained audit log — *Audit log → Verify integrity*
recomputes the chain. Side effects (security emails, subscriber notifications) go through a
transactional outbox delivered by the worker.

`ROLE=worker` runs background jobs without any API (health probes only); the compose `worker`
profile starts one so API and jobs scale separately.

## Accounts

Every device starts as a **guest** (`POST /sessions`): an anonymous identity that owns its sources.
Registering turns that same identity into an account (same user id), so nothing the guest added
is lost; the guest token is replaced by a new one. A guest that logs in to an *existing*
account passes `"mergeGuest": true` to move its sources into it (refused when the combined
total would exceed `MAX_SOURCES_PER_USER`).

- Passwords: 8–128 characters, hashed with scrypt (N=2^16, r=8, p=2; parameters are stored in the
  hash and upgraded on the next login). Emails are stored lower-cased.
- Sessions: one per device, opaque 256-bit bearer tokens stored as SHA-256 hashes. Account
  sessions expire after `SESSION_TTL_DAYS` (default 90) without use; guest sessions never do.
  Changing the password signs every other device out.
- Brute force: failed logins are limited per IP (20 / 10 min) and per targeted email
  (10 / 15 min). Limits are in memory, i.e. per instance — plug a shared store in
  `api/middleware/rate-limit.ts` before running several instances.
- Re-authentication failures on signed-in requests (wrong current password) answer **403**, not
  401, because the web client treats a 401 as "session died" and silently starts a new guest.
- Make someone an admin: `UPDATE users SET role = 'admin' WHERE email = '…';`
  (the role is stored and returned; no endpoint requires it yet).
- Email (forgotten password, address confirmation): see *Email* below.

## Email

Forgotten passwords and address confirmation work through links in emails. They are **off until you
configure outgoing mail** (the screens then show nothing that cannot work; `GET /auth/features` tells
them what is on). Set all three, in `.env`:

```
PUBLIC_URL=https://tv.example.com          # where users reach ZIPTV
SMTP_URL=smtps://user:password@smtp.example.com:465   # any SMTP provider; URL-encode @ : / in the password
MAIL_FROM="ZIPTV <no-reply@example.com>"
```

For local development, `MAIL_LOG_ONLY=true` prints emails (with their links) to the log instead of
sending them (refused in production: the log would contain working reset links).

How it is built, and why:
- Links use `PUBLIC_URL`, **never the request's `Host`**: otherwise a forged `Host` header could make a
  victim's email point at another site, with the victim's token in it.
- The token is in the URL **fragment** (`/reset-password#token=…`): never sent to servers, so not in
  logs or `Referer`; the page removes it from the address bar after reading it.
- Tokens are 256 random bits, stored only as SHA-256, single-use (one atomic `UPDATE`), and expire
  (reset: 1 hour, confirmation: 24 hours). A new link replaces the earlier ones.
- "Forgot password" answers the same for registered and unknown addresses and sends the email after
  answering, so neither the answer nor its timing reveals who is registered. Limits: 10/hour per IP,
  3/hour per address.
- A reset signs **every** device out, replaces other pending links, and confirms the address (the
  mailbox was proven). A too-weak new password is refused *before* the link is spent.
- Confirmation never blocks anything: an unconfirmed account works fully; Settings shows the status
  and can resend the link (3/hour).
- If the mail server fails, the person still gets the normal answer and the error is logged.
- Deliverability (SPF/DKIM/DMARC for your sending domain, a provider that does not land in spam) is the
  operator's part; the SMTP adapter is tested against a real local SMTP server, not against a provider.

## Playlists

A **source** is where channels come from (a provider's M3U, an uploaded file) and stays read-only.
A **playlist** is what a user builds from one or more sources: which channels, in which groups and
order, with which names and numbers. Entries *point at* source channels instead of copying their
stream URLs, so URLs stay current when a provider rotates tokens, while everything the user edited
lives in the playlist and survives re-syncs.

- **Build:** `POST /playlists/:id/entries/from-source` adds all channels, some source groups, or chosen
  channel keys, and places them in per-source groups, one chosen group, or none. It is idempotent
  (a channel appears once per playlist), so repeating "add all" picks up a source's new channels.
- **Organise:** create/rename/reorder/delete groups, move entries (relative order is kept, optionally
  before a given entry), edit name/logo/tvg-id/number, `renumber`, remove, copy or move between
  playlists, `merge` other playlists in. Entries are shown ungrouped first, then groups in order.
- **After a re-sync:** an entry whose channel disappeared is `status: "missing"` (derived, never
  stored) and left out of the export. Provider channel keys include the group, so a provider that
  re-groups a channel changes its key; entries are re-attached automatically after each sync by
  unique channel name (and on demand with `POST …/relink`).
- **Export:** `POST …/export` creates a link `https://host/p/<token>.m3u` (also `.m3u8`) that any player
  can load without a session. The link is a secret: it reveals the provider URLs of the playlist,
  so it is 256 random bits, stored hashed (lookup) and sealed (the owner can read it again),
  replaced by the next `POST` (the old link dies at once) and revoked with `DELETE`. Unknown,
  malformed and revoked links all answer the same 404, and the token is redacted from logs.
  `PUBLIC_URL` sets the origin used in links (default: the request's own).
  Stream headers a channel needs are written as `#EXTVLCOPT` lines; channels the web player cannot
  play (`unplayable`) are still exported for external players.
- Limits: `MAX_CUSTOM_PLAYLISTS_PER_USER` (20), `MAX_ENTRIES_PER_CUSTOM_PLAYLIST` (50 000).
- Deleting a source removes its channels from every playlist. Merging a guest into an account
  (`mergeGuest`) moves its playlists too.
- Measured with a 50 000-channel source in 100 groups: add all ≈ 2.7 s, playlist detail ≈ 0.1 s,
  any page of entries ≈ 0.15 s, move 100 entries ≈ 40 ms, export 8 MB ≈ 1 s (streamed; first byte
  in ms). Two things keep it that way and are worth knowing: planner statistics are refreshed with
  `ANALYZE` right after bulk loads (a fresh table has none, and the entry ↔ catalog joins then take
  minutes), and the export cuts a batch of entries *before* joining the catalog. After restoring a
  database dump, run `ANALYZE;` once.

## Web client: accounts and playlists

- **Sign in / register** (`/login`, `/register`, and Settings → Account, plus the account button in
  the top bar). A guest that registers keeps everything it added; a guest that signs in to an existing
  account can bring its sources and playlists along (ticked by default). Signed-in devices, password
  change and account deletion are in Settings.
- **Session ends:** an *account* whose session ended is sent to the sign-in page and returns to the
  page it was on afterwards; the app never silently starts an empty guest for it (that would look
  like lost data). A *guest* whose token is rejected just gets a new one. Sign-in requests never
  trigger the "renew my session" logic (`renewOn401: false`): a 401 there means "wrong password".
- **Playlists** (`/playlists`, `/playlists/:id`): the editor lists entries virtualised and server-paged
  (200 per page, only the pages near the viewport are fetched), so 50 000 channels scroll like 50.
  Regroup by dragging rows onto a group in the side panel or onto another row (desktop), or with
  **Move to…** (works on touch and keyboard). Other actions: add channels from a source (everything /
  groups / single channels, into source groups or one group), edit name/number/guide id/logo, group
  create/rename/reorder/delete, number channels, send/merge between playlists, reconnect or remove
  channels that vanished from their source, and the export link. "Select all" takes at most 5 000
  entries at once (it says so); narrow the view to select more.

### Tests that use the real server

`*.ui.test.tsx` render the real screens in jsdom against the real API on a throw-away PostgreSQL
database (the server's test harness is imported in-process), so a test covers component → hook →
HTTP → server → database. They need `TEST_DATABASE_URL` (like the server's integration tests) and
are skipped without it. They are not part of the client's `tsc` project (it does not compile server
code); Vitest runs them and ESLint checks them.

## Database

PostgreSQL with a typed query builder ([Kysely](https://kysely.dev)); SQL lives only in
`apps/server/src/infrastructure/persistence/postgres`. Use cases talk to repository *ports*
(`application/ports`), so nothing outside that folder knows which database is used.

- Migrations are forward-only TypeScript files in `persistence/postgres/migrations`, registered in
  `migrations/index.ts`; they run at boot under an advisory lock (safe with several instances).
  Never edit a released migration — add a new one.
- Entity ids are UUIDv7 generated by the application (`domain/shared/ids.ts`).
- Backup/restore: see the header of `docker-compose.yml`.

## Test coverage

The suite lives in `src/api`, `src/domain`, `src/infrastructure` (server), and
`src/features/live`, `src/features/player` (client). Repository and end-to-end tests need
`TEST_DATABASE_URL`, shared-state tests `TEST_REDIS_URL`; without them they are skipped.

The first deploy should be validated against a test database before using production
provider data. Build success verifies compilation, not provider connectivity or playback.
