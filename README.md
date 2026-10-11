# ZIPTV Player (3.x architecture)

TypeScript/React IPTV player with anonymous sessions, M3U file/URL sources, live-channel catalog,
stream playback planning, proxying and background source synchronization.

## Workspace

| Directory | Responsibility |
| --- | --- |
| `apps/server/src/api` | Express 5 API, middleware, route validation |
| `apps/server/src/application` | Use cases and repository/transport ports |
| `apps/server/src/domain` | Domain rules and identifiers |
| `apps/server/src/infrastructure` | Mongo adapters, parsers, media proxy, network/crypto implementation |
| `apps/server/src/container.ts` | Dependency-injection composition root |
| `apps/client/src` | React 19 + Vite 7 UI |
| `packages/contracts` | Shared types-only API contract (no runtime build) |

The production HTTP entry point is `apps/server/src/main.ts`, which imports `api/app.ts`.
The old `src/app.ts`, `src/modules` and old client playlists/watch implementation were
superseded during the 3.x migration and have been removed from the active source tree.
Old `/watch/:playlistId?/:channelKey?` links still redirect to `/live/...` in `app/App.tsx`.

## Start using Docker Compose

1. Copy `.env.example` to `.env`.
2. Set **two different, permanent** secrets: `STREAM_TOKEN_SECRET` and `DATA_ENCRYPTION_KEY`.
   Generate each with `openssl rand -base64 48`. Both are required in production.
   In particular, changing an existing encryption key without a key-rotation plan
   makes previously stored provider credentials unreadable.
3. Run `docker compose up -d --build`.
4. Open `http://localhost:8080` (or the configured `PORT`).

Compose provisions MongoDB and a combined API/UI container. If deploying on Render,
set `MONGO_URI` and keep the generated secrets stable across redeploys. If replacing an
existing instance, reuse its `DATA_ENCRYPTION_KEY`, not a newly generated one.

## Local development

Requires Node.js 22 (see `.nvmrc`) and MongoDB.

```sh
npm ci
cp apps/server/.env.example apps/server/.env
# Configure MONGO_URI in apps/server/.env
npm run dev:server
# In another terminal:
npm run dev:client
```

```sh
npm run build       # server TypeScript + client TypeScript and Vite production bundle
npm run typecheck   # server + client TypeScript validation
npm run lint        # ESLint
npm test            # unit tests; integration tests also run when TEST_MONGO_URI is set
```

For local work, use `npm ci` rather than copying `node_modules` from another OS.
Native Rollup/esbuild packages are platform-specific.

## HTTP API (`/api/v1`)

| Endpoint | Description |
| --- | --- |
| `POST /sessions`, `GET /sessions/me` | Anonymous session and identity |
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
are `MONGO_URI`, `STREAM_TOKEN_SECRET` and `DATA_ENCRYPTION_KEY`.
Source limits are `MAX_SOURCE_BYTES`, `MAX_ENTRIES_PER_SOURCE`, and `MAX_SOURCES_PER_USER`.
For compatibility, the config parser still accepts the former `MAX_PLAYLIST_*` variables.

`VITE_API_URL` selects the API origin for a separately hosted client. Leave it empty for
the single-origin Docker image. Set `ALLOW_PRIVATE_UPSTREAMS=true` only for trusted local
home-network deployments, not for a public server.

## Migration and test coverage

`npm run migrate:legacy -w @ziptv/server -- ...` migrates legacy 1.x playlist files into
new source records. Check the script's help and use `--dry-run` first. The current test
suite lives in `src/api`, `src/domain`, `src/infrastructure` (server), and
`src/features/live`, `src/features/player` (client).

The first deploy should be validated against a test database before using production
provider data. Build success verifies compilation, not provider connectivity or playback.
