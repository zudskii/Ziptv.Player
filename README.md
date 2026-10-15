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
| `GET /sources`, `POST /sources`, `POST /sources/upload` | List/add M3U or Xtream sources |
| `GET/PATCH/DELETE /sources/:sourceId` | Source details/maintenance |
| `POST /sources/:sourceId/sync` | Queue source synchronization |
| `POST /sources/:sourceId/file` | Replace uploaded source data |
| `GET /live/:sourceId/channels` | Live catalog with ETag revalidation |
| `GET /live/:sourceId/channels/:key` | Channel details |
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

`VITE_API_URL` selects the API origin for a separately hosted client. Leave it empty for
the single-origin Docker image. Set `ALLOW_PRIVATE_UPSTREAMS=true` only for trusted local
home-network deployments, not for a public server.

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
- Not built yet: password reset and email verification (both need an email provider).

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
`TEST_DATABASE_URL`; without it they are skipped.

The first deploy should be validated against a test database before using production
provider data. Build success verifies compilation, not provider connectivity or playback.
