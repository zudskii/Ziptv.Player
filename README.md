# ZIPTV Player 2.0

Web IPTV player: upload an M3U/M3U8/PLS playlist or import it by URL, browse groups, search,
keep favorites, and play HLS, MPEG-TS, FLV, MP4/WebM and DASH streams in the browser — including
`http://` streams on an `https://` site and streams that require a specific User-Agent/Referer.

```
apps/server     Node 22 · TypeScript · Express 5 · MongoDB (Mongoose) · undici
apps/client     React 19 · TypeScript · Vite · Tailwind 3 · TanStack Query · Zustand · hls.js / mpegts.js / dash.js
packages/contracts   Types-only API contract shared by both apps
```

---

## Quick start

### Docker (API + client on one origin)

```bash
cp .env.example .env                                   # set STREAM_TOKEN_SECRET (openssl rand -base64 48)
docker compose up -d --build                           # → http://localhost:8080
```

### Local development

Requirements: Node 22 (`.nvmrc`), a MongoDB (local or Atlas).

```bash
npm ci
cp apps/server/.env.example apps/server/.env           # set MONGO_URI
npm run dev:server                                     # API on :8080
npm run dev:client                                     # UI on :5173, /api proxied to :8080
```

| Command             | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `npm run lint`      | ESLint (TypeScript + React Hooks rules) for both apps              |
| `npm run typecheck` | `tsc` for server and client                                        |
| `npm test`          | Server: parser, proxy, SSRF, HTTP e2e · Client: browse logic, player state machine |
| `npm run build`     | Compiles the server to `apps/server/dist`, bundles the client to `apps/client/dist` |
| `npm run parse -w @ziptv/server -- list.m3u` | Parse a local playlist and print groups/kinds/warnings |

Set `TEST_MONGO_URI=mongodb://localhost:27017` to also run the MongoDB repository integration tests (CI does).

---

## Architecture

```
 Browser ─────────────────────────────────────────────────────────────────────────────┐
  React SPA                                                                           │
   ├─ JSON API (Bearer token) ──► /api/v1/sessions · /playlists · /playback           │
   └─ <video>/hls.js/mpegts.js ─► direct to provider   or   /api/v1/media/stream/:token
                                   (CORS permitting)         (signed proxy URL)        │
 ─────────────────────────────────────────────────────────────────────────────────────┘
 Server (Express 5)
   routes (HTTP only: validation, status codes)
     └─ services (use cases, invariants, ownership)        SessionService · PlaylistService · PlaybackService
          ├─ repositories (ports) ─► Mongo adapters         users · playlists · channels
          ├─ m3u module (pure, no I/O)                      decode → scan → normalise → keys
          └─ UpstreamClient (undici)                        SSRF guard · redirects · timeouts · size caps
                └─► IPTV providers / CDNs
```

**Layering rules.** Routes never contain business logic; services never import Express or
Mongoose; repositories are interfaces with Mongo implementations (tests swap in in-memory ones);
the M3U parser is a pure module; `container.ts` is the only place that wires concrete classes.
`config/env.ts` validates the environment once at boot — nothing else reads `process.env`.

### Why streams now open

The client never decides *how* to play; it asks `POST /api/v1/playback` and gets an ordered list
of candidates, then tries them until one plays (`PlaybackController`).

| Situation                                        | What happens                                                    |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `https://` stream, CORS allowed                   | Direct playback (no server bandwidth)                           |
| Stream without CORS headers                       | Direct attempt fails fast → proxy                               |
| `http://` stream on an `https://` page            | Proxy only (browsers block mixed content)                       |
| Needs User-Agent/Referer/Cookie (`#EXTVLCOPT`, `\|User-Agent=`, `#EXTHTTP`, `#KODIPROP`) | Proxy first (browsers cannot set these headers) |
| `.m3u8`                                           | hls.js (native HLS on iOS without MSE)                           |
| `.ts` / extension-less Xtream URL                 | Server sniffs the first bytes once (cached) → mpegts.js         |
| `.mp4` / `.webm` / audio                          | Native `<video>`                                                 |
| `.mpd` (clear DASH)                               | dash.js (lazy-loaded)                                            |
| RTMP/RTSP/UDP, DRM, YouTube/Twitch pages          | Flagged at import, explained in the UI (not playable in a browser) |

The proxy (`/api/v1/media/stream/:token`) fetches only **HMAC-signed** URLs issued by the server
(channel URLs and the URIs inside their HLS manifests), so it is not an open relay. HLS manifests
are detected by content (providers often send `text/html`), every URI (variants, segments, keys,
init segments, renditions) is rewritten to a relative signed token, redirects are followed, Range
requests pass through, and the upstream request is aborted the moment the viewer leaves. Tokens
are stateless, so the proxy scales horizontally.

Once playing, the controller recovers from network/media errors (hls.js recovery ladder), detects
stalls, and reconnects with a *fresh plan* (fresh tokens) with exponential backoff.

### M3U parsing guarantees

- Every entry with a usable URL becomes a channel; a missing title falls back to `tvg-name`, then to the URL.
- Titles are split at the first comma **outside quotes** (`tvg-name="News, Weather"` no longer leaks into names); `" - "` in names is preserved.
- `#EXTVLCOPT`, `#EXTGRP`, `#EXTIMG`, `#EXTHTTP`, `#KODIPROP` and `|Header=` suffixes are attached to their entry.
- Encodings: UTF-8 (with/without BOM), UTF-16 LE/BE, legacy windows-1251/1252. CRLF/CR/LF.
- Groups: `group-title` → `#EXTGRP` → none. `a;b` multi-groups are split (Kodi/iptv-org convention); `Sports`/`SPORTS `/` sports` are one group under the first spelling; playlist order is kept.
- Relative stream/logo URLs are resolved against the playlist URL (URL imports).
- HTML error pages and single-stream HLS manifests are recognised with actionable messages.
- Nothing is lost: all EXTINF attributes are stored; skipped lines are reported with line numbers.

Performance: ~27 ms for a 1,200-channel list, ~1.2 s for 100k channels (20 MB).

---

## API (v1)

All JSON endpoints except `POST /sessions` require `Authorization: Bearer <token>`.
Errors always have the shape `{ "error": { "code", "message", "details?", "requestId?" } }` (see `packages/contracts`).

| Method & path                                         | Purpose                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `POST /api/v1/sessions`                               | Create an anonymous device session (optionally exchange a 1.x `legacySecretId`) |
| `GET  /api/v1/sessions/me`                            | Current session                                          |
| `GET  /api/v1/playlists`                              | List playlists                                           |
| `POST /api/v1/playlists/upload`                       | Multipart upload (`file`, optional `name`)               |
| `POST /api/v1/playlists/import`                       | `{ url, name? }` — import from a provider URL            |
| `GET/PATCH/DELETE /api/v1/playlists/:id`              | Get / rename / delete                                    |
| `POST /api/v1/playlists/:id/refresh`                  | Re-download a URL playlist (atomic swap, new revision)   |
| `GET  /api/v1/playlists/:id/channels`                 | Channel list (no stream URLs), `ETag` per revision       |
| `POST /api/v1/playback`                               | `{ playlistId, channelKey, secureContext }` → ordered candidates |
| `GET  /api/v1/media/stream/:token`                    | Signed streaming proxy (public, CORS `*`)                |
| `GET  /api/v1/media/logos/:playlistId/:channelKey`    | Logo proxy (mixed content, hotlink protection), cacheable |
| `GET  /healthz` · `GET /readyz`                       | Liveness · readiness (MongoDB connected)                 |

---

## Configuration

Server (`apps/server/.env.example` documents every variable):

| Variable                   | Default                    | Notes |
| -------------------------- | -------------------------- | ----- |
| `MONGO_URI`                | —                          | Required. Use a **new** database for 2.x. |
| `STREAM_TOKEN_SECRET`      | random (dev only)          | Required in production, ≥ 32 chars. |
| `CORS_ORIGINS`             | empty (same origin)        | Comma-separated, only when the client is hosted elsewhere. |
| `TRUST_PROXY`              | `0`                        | Proxy hops (Render `1`, Cloudflare+Render `2`) — needed for correct client IPs/rate limits. |
| `CLIENT_DIST_DIR`          | —                          | Serve the built client from the API (single-origin deploy; the Docker image sets it). |
| `ALLOW_PRIVATE_UPSTREAMS`  | `false`                    | Allow LAN sources (home server). Never on a public server. |
| `UPSTREAM_USER_AGENT`      | `VLC/3.0.21 LibVLC/3.0.21` | Many panels only answer player user agents. |
| `MAX_PLAYLIST_BYTES` / `MAX_CHANNELS_PER_PLAYLIST` / `MAX_PLAYLISTS_PER_USER` | 30 MB / 100k / 30 | Abuse limits. |

Client: `VITE_API_URL` (build time) — empty for same-origin, otherwise the API origin, e.g. `https://ziptv-api.onrender.com`.

---

## Deployment

**Render (recommended, one service).** Create a Blueprint from `render.yaml` (Docker runtime) and
set `MONGO_URI` (MongoDB Atlas). The image serves API and client on one origin.
If you build on Render without Docker: `npm ci --include=dev && npm run build`, start with
`CLIENT_DIST_DIR=../client/dist npm start -w @ziptv/server` (paths are relative to `apps/server`) — note `--include=dev`: with
`NODE_ENV=production`, a plain `npm ci` skips TypeScript and the build fails.

**Client on static hosting (e.g. InfinityFree) + API elsewhere.** Build with
`VITE_API_URL=https://<api-host> npm run build -w @ziptv/client`, upload `apps/client/dist/`
(an `.htaccess` for SPA deep links is included) and set `CORS_ORIGINS=https://<client-host>` on the API.

**Behind Cloudflare.** Cache `/assets/*` and `/api/v1/media/logos/*`; bypass cache for
`/api/v1/media/stream/*` and `/api/v1/*`. Proxying video through Cloudflare's CDN is restricted
by their plan terms — check the current terms, or serve the API from a DNS-only hostname.

---

## Migrating from 1.x

1.x stored files on the server disk (lost on every Render redeploy) and identified users by a
`secretId` in URLs. 2.x stores parsed channels in MongoDB and uses hashed bearer tokens.

```bash
# 1. Rotate the MongoDB password that was committed in Ziptv.Server/.env.
# 2. Import old data into the NEW database (read-only on the old one, idempotent):
cd apps/server
MONGO_URI="mongodb+srv://…/ziptv" npm run migrate:legacy -- \
  --legacy-uri "mongodb+srv://…/m3uplaylist" --files ../../../Ziptv.Server/m3ulist
```

When a 1.x user opens the new client, it reads the old id from `localStorage` once, exchanges it
(`POST /sessions { legacySecretId }`) and they see their playlists again. Old `/tv/...` links redirect to `/watch`.

---

## Security

- Sessions: 256-bit random tokens, stored as SHA-256 hashes, sent only in headers; every query is owner-scoped.
- SSRF: all outbound requests go through `UpstreamClient` — http(s) only, private/loopback/link-local/metadata ranges blocked at **connect time** (DNS-rebinding safe), each redirect re-validated, credentials dropped on cross-origin redirects, size caps also after decompression.
- Proxy URLs are HMAC-signed and expire; logos are only fetched for stored channels and served with a sandbox CSP.
- Uploads are parsed in memory (no user-controlled file paths — the 1.x path-traversal/arbitrary-write issue is gone).
- helmet with a CSP suited to a media player (scripts same-origin, media/images from providers), rate limits per IP/user, JSON body limits, structured logs with token redaction, graceful shutdown.

---

## Known limits and next steps

- RTMP/RTSP/UDP and DRM (Widevine) channels cannot be played by any browser; that would need a transcoding service (ffmpeg → HLS).
- H.264/AAC playback depends on the browser (all major browsers support it; open-source Chromium builds do not).
- Rate-limit counters are in-memory per instance; with several instances use a shared store (`rate-limit-redis`).
- Imports parse synchronously (~12 µs/channel). For many concurrent 100k-entry imports, move imports to a background job (e.g. BullMQ).
- EPG (XMLTV): `x-tvg-url`/`url-tvg` and `tvg-id` are already parsed and stored, ready for a guide feature.
