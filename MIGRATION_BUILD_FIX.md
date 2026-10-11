# Build repair notes (2026-10-11)

## Root cause

The 3.x rewrite shipped alongside 2.x implementation files. TypeScript's `include: ["src"]`
compiled obsolete implementations even though the server booted from `src/api/app.ts`, and
Vite's TypeScript build checked unreachable 2.x playlist/watch screens. The old code depended
on removed contracts (`PlaylistDto`, old `PlaybackPlanDto`) and constructor types that no
longer matched the composition root.

## Removals

- Server: obsolete `src/app.ts`, `src/http-paths.ts`, `src/modules/**`, `src/shared/**` and
  their stale 2.x tests/in-memory repository fixture.
- Client: unreachable `src/features/playlists/**`, `src/features/channels/**` and
  `src/pages/watch/**`. Current implementations are `features/sources`, `features/live`
  and `pages/live`. `/watch` redirects stay intact.

The original supplied archive remains unchanged. These removals do not change the active
server imports or configured client routes.

## Deployment configuration corrections

- Required `DATA_ENCRYPTION_KEY` now passes through Docker Compose (app and tools service).
- Render's blueprint defines `DATA_ENCRYPTION_KEY`.
- Environment examples show the current source limit names and production encryption key.
- README describes the 3.x routes and architecture.

**Important:** If the application already stores encrypted provider URLs/credentials,
reuse the current `DATA_ENCRYPTION_KEY` for all redeploys. Do not let Render regenerate it
for an existing installation.

## Verification in the repair environment

- `npm run build -w @ziptv/server`: passes.
- `npm run typecheck -w @ziptv/server`: passes.
- `npm run typecheck -w @ziptv/client`: passes.
- Built server HTTP smoke test: `/healthz` 200; `/readyz` 503 when not ready;
  unauthenticated `/api/v1/live` 401; unknown route 404.
- Full client Vite bundling/Vitest could not execute locally because the supplied
  `node_modules` came from Windows and lacks Linux Rollup/esbuild optional native modules.
  Network was unavailable for `npm ci` in the repair environment. Run `npm ci`,
  `npm run build`, `npm run lint` and `npm test` in clean CI or Docker (requires network
  access on first install).
