import type { Migration } from 'kysely/migration';

import * as core from './0001-core.js';
import * as accounts from './0002-accounts.js';

/**
 * Forward-only migrations, applied in key order. Add a new file and register it here;
 * never edit a migration that has been released (write a new one instead).
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001-core': core,
  '0002-accounts': accounts,
};
