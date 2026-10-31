import type { CatalogBuild, LiveChannelEntry } from '../../domain/catalog/model.js';
import { computeStats, isCatalogEmpty } from '../../domain/catalog/model.js';
import { nextSyncAt, problemFromAccount, type SourceProblem, type SourceType } from '../../domain/sources/source.js';
import { AppError } from '../errors.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { Cache } from '../ports/cache.js';
import { SourceFetchError, type CatalogProvider } from '../ports/catalog-provider.js';
import type { AddedAtIndex, CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import { toStoredRevision } from './catalog-storage.js';
import type { CatalogEpgLinker, SourceRevisionListener } from './hooks.js';
import type { SourceSecrets } from './secrets.js';

export interface SyncLease {
  owner: string;
  /** Aborted when the lease is lost or the process shuts down. */
  signal: AbortSignal;
}

export interface SourceSyncDeps {
  sources: SourceRepository;
  catalog: CatalogRepository;
  providers: Partial<Record<SourceType, CatalogProvider>>;
  secrets: SourceSecrets;
  epg: CatalogEpgLinker;
  revisionListeners: SourceRevisionListener[];
  notifications: NotificationService;
  cache: Cache;
  clock: Clock;
  logger: Logger;
}

/** Cache prefix of everything derived from one source. */
export const sourceCachePrefix = (sourceId: string): string => `source:${sourceId}:`;

/**
 * One sync of one source, end to end:
 *
 *   fetch + parse (provider adapter) → link EPG → build revision N+1 → CAS swap → GC N
 *
 * Readers always see a complete revision: the new one is written next to the old one and
 * becomes visible only through the compare-and-set on `source.revision`. The pipeline runs
 * under a lease (see JobRunner), so several instances never sync the same source at once.
 */
export class SourceSyncPipeline {
  constructor(private readonly deps: SourceSyncDeps) {}

  async run(source: SourceRecord, lease: SyncLease, prebuilt?: CatalogBuild): Promise<SourceRecord | null> {
    const { sources, catalog, logger } = this.deps;
    const startedAt = this.deps.clock.now();
    const log = logger.child({ sourceId: source.id, type: source.type });

    try {
      const build = prebuilt ?? (await this.fetch(source, lease));
      this.assertUsable(build);
      lease.signal.throwIfAborted();

      await sources.setStage(source.id, lease.owner, 'matching_epg');
      await this.deps.epg.linkBuild(source, build.live);

      await sources.setStage(source.id, lease.owner, 'building_library');
      const previous = source.revision > 0 ? await catalog.addedAtIndex(source.id, source.revision) : null;
      const added = applyAddedAt(build, previous, startedAt);
      const revision = source.revision + 1;

      await catalog.deleteRevision(source.id, revision); // leftovers of a crashed attempt
      await catalog.insertRevision(source.id, revision, toStoredRevision(build, this.deps.secrets));
      lease.signal.throwIfAborted();

      const committed = await sources.commitRevision(source.id, lease.owner, source.revision, {
        revision,
        stats: computeStats(build),
        epgUrls: build.epgUrls.map((url) => this.deps.secrets.sealGuideUrl(url)),
        warnings: build.warnings,
        warningCount: build.warningCount,
        format: build.format,
        encoding: build.encoding,
        account: build.account,
        xtreamCandidate: build.xtreamCandidate,
      });
      if (!committed) {
        await catalog.deleteRevision(source.id, revision);
        log.warn('Source revision swap lost a race; discarded the new revision');
        return null;
      }

      await catalog.deleteOtherRevisions(source.id, revision);
      this.deps.cache.deleteByPrefix(sourceCachePrefix(source.id));
      for (const listener of this.deps.revisionListeners) {
        await listener.onRevisionCommitted(committed).catch((error: unknown) => log.warn({ err: error }, 'Revision listener failed'));
      }
      await this.deps.epg.afterCommit(committed, build.epgUrls).catch((error: unknown) => log.warn({ err: error }, 'EPG attach after sync failed'));

      const finished = await sources.completeSync(source.id, lease.owner, {
        status: 'idle',
        error: null,
        lastSuccessAt: startedAt,
        nextSyncAt: nextSyncAt({ ...this.schedule(committed), now: this.deps.clock.now(), consecutiveFailures: 0 }),
        consecutiveFailures: 0,
      });

      await this.notifySuccess(source, committed, added);
      log.info({ revision, live: build.live.length, movies: build.movies.length, series: build.series.length, ms: Date.now() - startedAt.getTime() }, 'Source synced');
      return finished;
    } catch (error) {
      if (lease.signal.aborted) {
        log.info('Source sync interrupted (lease lost or shutting down)');
        return null;
      }
      return this.fail(source, lease, error);
    }
  }

  private async fetch(source: SourceRecord, lease: SyncLease): Promise<CatalogBuild> {
    const provider = this.deps.providers[source.type];
    if (!provider) throw new AppError('SOURCE_NOT_SYNCABLE', 409, 'This source cannot be synced. Upload the file again instead.');
    const credential = this.deps.secrets.openCredential(source.credential);
    return provider.fetchCatalog(credential, {
      signal: lease.signal,
      onStage: (stage) => this.deps.sources.setStage(source.id, lease.owner, stage),
    });
  }

  private assertUsable(build: CatalogBuild): void {
    if (build.account) {
      const problem = problemFromAccount(build.account, this.deps.clock.now());
      if (problem === 'expired') throw new SourceFetchError('expired', 'The provider reports that this subscription has expired.');
      if (problem) throw new SourceFetchError(problem, `The provider reports the account as "${build.account.status}".`);
    }
    if (isCatalogEmpty(build)) {
      throw new SourceFetchError('empty', 'No playable entries were found in this source.', { warnings: build.warnings.slice(0, 20) });
    }
  }

  private async fail(source: SourceRecord, lease: SyncLease, error: unknown): Promise<SourceRecord | null> {
    const { problem, message } = classifyFailure(error);
    const consecutiveFailures = source.sync.consecutiveFailures + 1;
    const level = problem === 'unknown' ? 'error' : 'warn';
    this.deps.logger[level]({ err: error, sourceId: source.id, problem }, 'Source sync failed');

    const finished = await this.deps.sources.completeSync(source.id, lease.owner, {
      status: 'failed',
      error: { problem, message },
      nextSyncAt: nextSyncAt({ ...this.schedule(source), now: this.deps.clock.now(), consecutiveFailures }),
      consecutiveFailures,
    });

    // Only the transition to "failed" is announced; retries of a known failure stay quiet.
    // A brand-new upload that cannot be read is rejected in the request instead.
    const rejectedUpload = source.type === 'm3u_file' && source.revision === 0;
    if (!rejectedUpload && (!source.sync.error || source.sync.error.problem !== problem)) {
      await this.deps.notifications.notify({
        ownerId: source.ownerId,
        type: 'source_failed',
        severity: 'error',
        title: `${source.name}: ${PROBLEM_TITLES[problem]}`,
        body: message,
        link: '/sources',
        dedupeKey: `source_failed:${source.id}`,
      });
    }
    return finished;
  }

  private async notifySuccess(before: SourceRecord, after: SourceRecord, added: AddedCounts): Promise<void> {
    const { notifications } = this.deps;
    const base = { ownerId: after.ownerId, link: '/sources' };
    if (before.revision === 0) {
      await notifications.notify({
        ...base,
        type: 'source_synced',
        severity: 'success',
        title: `${after.name} is ready`,
        body: describeLibrary(after),
        link: '/',
        dedupeKey: `source_synced:${after.id}`,
      });
      return;
    }
    if (added.live > 0 || added.movies > 0 || added.series > 0) {
      const parts = [
        added.live > 0 ? `${added.live} new channel${added.live === 1 ? '' : 's'}` : null,
        added.movies > 0 ? `${added.movies} new movie${added.movies === 1 ? '' : 's'}` : null,
        added.series > 0 ? `${added.series} new series` : null,
      ].filter(Boolean);
      await notifications.notify({
        ...base,
        type: 'channels_added',
        severity: 'info',
        title: `${after.name} refreshed`,
        body: `${parts.join(', ')} added`,
        dedupeKey: `channels_added:${after.id}`,
      });
    } else if (before.sync.error) {
      await notifications.notify({
        ...base,
        type: 'source_synced',
        severity: 'success',
        title: `${after.name} is working again`,
        body: describeLibrary(after),
        dedupeKey: `source_failed:${after.id}`,
      });
    }
  }

  private schedule(source: SourceRecord) {
    return { type: source.type, autoSync: source.sync.autoSync, intervalHours: source.sync.intervalHours };
  }
}

interface AddedCounts {
  live: number;
  movies: number;
  series: number;
}

/**
 * Carries "first seen" dates from the previous revision, so "Recently added" and
 * "12 new channels" mean *new since the last sync*. On the very first sync nothing is "new"
 * (only provider-supplied dates, e.g. Xtream `added`, are kept).
 */
function applyAddedAt(build: CatalogBuild, previous: AddedAtIndex | null, now: Date): AddedCounts {
  const counts: AddedCounts = { live: 0, movies: 0, series: 0 };
  const carry = <T extends { key: string; addedAt: Date | null }>(items: T[], index: Map<string, Date | null> | undefined, kind: keyof AddedCounts) => {
    for (const item of items) {
      if (!index) continue; // first sync: keep provider dates as they are
      if (index.has(item.key)) {
        item.addedAt = item.addedAt ?? index.get(item.key) ?? null;
      } else {
        item.addedAt = item.addedAt ?? now;
        counts[kind]++;
      }
    }
  };
  carry<LiveChannelEntry>(build.live, previous?.live, 'live');
  carry(build.movies, previous?.movies, 'movies');
  carry(build.series, previous?.series, 'series');
  return counts;
}

function describeLibrary(source: SourceRecord): string {
  const { live, movies, series } = source.stats;
  const parts = [
    live > 0 ? `${live.toLocaleString('en-US')} channels` : null,
    movies > 0 ? `${movies.toLocaleString('en-US')} movies` : null,
    series > 0 ? `${series.toLocaleString('en-US')} series` : null,
  ].filter(Boolean);
  return parts.join(' · ') || 'Library updated';
}

const PROBLEM_TITLES: Record<SourceProblem, string> = {
  auth_failed: 'authentication failed',
  expired: 'playlist expired',
  unavailable: 'source unavailable',
  invalid: 'not a valid playlist',
  empty: 'no channels found',
  too_large: 'playlist too large',
  blocked: 'address not allowed',
  unknown: 'sync failed',
};

export function classifyFailure(error: unknown): { problem: SourceProblem; message: string } {
  if (error instanceof SourceFetchError) return { problem: error.problem, message: error.message };
  if (error instanceof AppError) {
    const problem: SourceProblem =
      error.code === 'SOURCE_AUTH_FAILED'
        ? 'auth_failed'
        : error.code === 'SOURCE_EXPIRED'
          ? 'expired'
          : error.code === 'SOURCE_EMPTY'
            ? 'empty'
            : error.code === 'SOURCE_INVALID'
              ? 'invalid'
              : error.code === 'PAYLOAD_TOO_LARGE'
                ? 'too_large'
                : error.code === 'UPSTREAM_BLOCKED'
                  ? 'blocked'
                  : 'unavailable';
    return { problem, message: error.message };
  }
  return { problem: 'unknown', message: 'Something went wrong while reading this source. ZIPTV will retry automatically.' };
}
