import type { Migration } from 'kysely/migration';

import * as core from './0001-core.js';
import * as accounts from './0002-accounts.js';
import * as playlists from './0003-playlists.js';
import * as emailTokens from './0004-email-tokens.js';
import * as operatorFoundation from './0005-operator-foundation.js';
import * as epg from './0006-epg.js';
import * as viewer from './0007-viewer.js';
import * as operatorCatalog from './0008-operator-catalog.js';
import * as streamHealth from './0009-stream-health.js';
import * as commerce from './0010-commerce.js';
import * as consoleModule from './0011-console.js';
import * as viewerControls from './0012-viewer-controls.js';
import * as profileLibrary from './0013-profile-library.js';
import * as vodFilters from './0014-vod-filters.js';
import * as providerFeeds from './0015-provider-feeds.js';

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
  '0008-operator-catalog': operatorCatalog,
  '0009-stream-health': streamHealth,
  '0010-commerce': commerce,
  '0011-console': consoleModule,
  '0012-viewer-controls': viewerControls,
  '0013-profile-library': profileLibrary,
  '0014-vod-filters': vodFilters,
  '0015-provider-feeds': providerFeeds,
};
