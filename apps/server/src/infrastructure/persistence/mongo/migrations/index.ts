import { sourcesFromPlaylists } from './001-sources-from-playlists.js';
import type { Migration } from './runner.js';

/** All data migrations, applied in id order at startup (and by `npm run migrate`). */
export const MIGRATIONS: Migration[] = [sourcesFromPlaylists];

export { runMigrations, type Migration, type MigrationContext } from './runner.js';
