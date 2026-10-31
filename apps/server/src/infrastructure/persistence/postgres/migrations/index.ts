import type { Migration } from 'kysely/migration';

import * as core from './0001-core.js';
import * as accounts from './0002-accounts.js';
import * as playlists from './0003-playlists.js';
import * as emailTokens from './0004-email-tokens.js';
import * as operatorFoundation from './0005-operator-foundation.js';
import * as epg from './0006-epg.js';
import * as viewer from './0007-viewer.js';

/**
 * Forward-only migrations, applied in key order. Add a new file and register it here;
 * never edit a migration that has been released (write a new one instead).
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001-core': core,
  '0002-accounts': accounts,
  '0003-playlists': playlists,
  '0004-email-tokens': emailTokens,
  '0005-operator-foundation': operatorFoundation,
  '0006-epg': epg,
  '0007-viewer': viewer,
};
