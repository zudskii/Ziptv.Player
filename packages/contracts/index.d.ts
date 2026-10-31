/**
 * ZIPTV HTTP API contract (v1).
 *
 * Single source of truth for request/response shapes shared by the server and the client.
 * This package is intentionally types-only (.d.ts files): it is erased at build time,
 * so neither app pays a runtime cost and no build step is needed.
 */
export * from './common';
export * from './identity';
export * from './sources';
export * from './catalog';
export * from './epg';
export * from './playback';
export * from './user-state';
export * from './playlists';
export * from './admin';
