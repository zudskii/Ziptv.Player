import type { SourceDto } from '@ziptv/contracts';

import { maskUsername } from '../../domain/sources/source.js';
import type { SourceRecord } from '../ports/source-repository.js';
import { NO_GUIDES, type SourceGuideSummary } from './hooks.js';

/** Cache key of everything derived from a source revision (lists, now/next links, library). */
export function catalogVersion(source: Pick<SourceRecord, 'revision' | 'epgVersion'>): string {
  return `${source.revision}.${source.epgVersion}`;
}

export function toSourceDto(source: SourceRecord, guides: SourceGuideSummary = NO_GUIDES): SourceDto {
  const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    origin:
      source.origin.kind === 'xtream'
        ? { kind: 'xtream', host: source.origin.host, username: maskUsername(source.origin.username) }
        : source.origin,
    revision: source.revision,
    catalogVersion: catalogVersion(source),
    sync: {
      status: source.sync.status,
      stage: source.sync.status === 'running' ? source.sync.stage : null,
      autoSync: source.sync.autoSync,
      intervalHours: source.sync.intervalHours,
      lastAttemptAt: iso(source.sync.lastAttemptAt),
      lastSuccessAt: iso(source.sync.lastSuccessAt),
      nextSyncAt: iso(source.sync.nextSyncAt),
      error: source.sync.error,
    },
    stats: source.stats,
    health: {
      state: source.health.state,
      checkedAt: iso(source.health.checkedAt),
      latencyMs: source.health.latencyMs,
      unstableStreams: source.health.unstableStreams,
      offlineStreams: source.health.offlineStreams,
      message: source.health.message,
    },
    account: source.account
      ? {
          status: source.account.status,
          expiresAt: iso(source.account.expiresAt),
          maxConnections: source.account.maxConnections,
          activeConnections: source.account.activeConnections,
          trial: source.account.trial,
        }
      : null,
    epg: { guides: guides.guides, version: guides.version, syncing: guides.syncing },
    warnings: source.warnings,
    warningCount: source.warningCount,
    xtreamCandidate: source.xtreamCandidate,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}
