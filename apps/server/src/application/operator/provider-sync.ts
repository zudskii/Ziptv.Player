import { aliasKeys } from '../../domain/operator/catalog.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import type { Worker } from '../jobs/job-runner.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { OperatorCatalogRepository, ProviderAdapters, ProviderRecord, ProviderStreamRecord } from '../ports/operator.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { classifyFailure } from '../sources/source-sync.pipeline.js';
import type { ProviderConnections } from './provider-connections.js';

export const PROVIDER_SYNC_JOB = 'provider-sync';
const RETRY_MS = 15 * 60_000;
const MAX_SUGGESTIONS = 500;
/** Feeds created by automatic matching start after the existing ones (backups by default). */
const PRIORITY_STEP = 10;

/**
 * Provider ingestion: provider → its channel list → `provider_streams` (new / seen / gone) →
 * matching against the master catalog by alias keys:
 *   tvg-id alias  ▶ normalised-name alias  → matched, feed created (auto)
 *   otherwise     → pending in the review queue, with a suggested channel when one looks close
 * Aliases exist only for curated channels (created or confirmed by staff), so automatic
 * matching never invents channels; it only recognises streams of channels already in the catalog.
 */
export class ProviderSyncService {
  constructor(
    private readonly deps: {
      catalog: OperatorCatalogRepository;
      adapters: ProviderAdapters;
      connections: ProviderConnections;
      secrets: SourceSecrets;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async run(provider: ProviderRecord, lease: { owner: string; signal: AbortSignal }): Promise<void> {
    const { catalog, clock } = this.deps;
    const log = this.deps.logger.child({ providerId: provider.id });
    try {
      const connection = await this.deps.connections.open(provider);
      const { channels } = await this.deps.adapters[provider.type].listChannels(provider, connection, lease.signal);
      lease.signal.throwIfAborted();
      const now = clock.now();
      const upserted = await catalog.upsertStreams(
        provider.id,
        channels.map((channel) => ({ ...channel, locator: this.deps.secrets.sealLocator(channel.locator) })),
        now,
      );
      const gone = await catalog.markGone(provider.id, now);
      const matched = await this.match([...upserted.values()].filter((stream) => stream.status === 'pending'));
      const stats = await catalog.providerStats(provider.id);
      await catalog.completeProviderSync(provider.id, lease.owner, { ok: true, error: null, stats, nextAt: new Date(now.getTime() + provider.syncIntervalHours * 3600_000), now });
      log.info({ streams: channels.length, matched, gone, pending: stats.pending }, 'Provider synced');
    } catch (error) {
      if (lease.signal.aborted) return;
      const { message } = classifyFailure(error);
      const now = clock.now();
      log.warn({ err: error }, 'Provider sync failed');
      await catalog.completeProviderSync(provider.id, lease.owner, { ok: false, error: message, nextAt: new Date(now.getTime() + RETRY_MS), now });
    }
  }

  /** Auto-matches pending streams; returns how many were matched. */
  private async match(pending: ProviderStreamRecord[]): Promise<number> {
    if (pending.length === 0) return 0;
    const { catalog } = this.deps;
    const byAlias = await catalog.channelsByAlias(pending.flatMap((stream) => aliasKeys(stream)));
    let matched = 0;
    let suggestions = 0;
    for (const stream of pending) {
      const hit = aliasKeys(stream)
        .map((alias) => ({ alias, channelId: byAlias.get(`${alias.kind}\u0000${alias.key}`) }))
        .find((entry) => entry.channelId);
      if (hit?.channelId) {
        // Only while still pending: a console decision taken during this sync wins.
        if (await this.attach(stream, hit.channelId, hit.alias.kind, catalog, 'pending')) matched++;
        continue;
      }
      if (suggestions < MAX_SUGGESTIONS) {
        suggestions++;
        const suggestion = await this.suggest(stream);
        if (suggestion) await catalog.setStreamState(stream.id, { status: 'pending', suggestion }, 'pending');
      }
    }
    return matched;
  }

  /**
   * Links a stream to a channel and gives the channel a feed from it (idempotent). With
   * `expected`, nothing happens unless the stream is still in that status (returns false).
   */
  async attach(
    stream: ProviderStreamRecord,
    channelId: string,
    method: 'tvg_id' | 'name' | 'manual',
    repository: OperatorCatalogRepository = this.deps.catalog,
    expected?: 'pending',
  ): Promise<boolean> {
    if (!(await repository.setStreamState(stream.id, { status: 'matched', channelId, matchMethod: method, suggestion: null }, expected))) return false;
    const existing = await repository.findFeedByStream(stream.id);
    if (existing) {
      if (existing.channelId !== channelId) {
        await repository.deleteFeed(existing.id);
      } else {
        return true;
      }
    }
    const feeds = await repository.feedsOf([channelId]);
    const priority = feeds.length === 0 ? 100 : Math.max(...feeds.map((feed) => feed.priority)) + PRIORITY_STEP;
    await repository.createFeed({ id: repository.newId(), channelId, providerId: stream.providerId, providerStreamId: stream.id, priority });
    return true;
  }

  /** A close channel for the reviewer: same first words of the normalised name. */
  private async suggest(stream: ProviderStreamRecord): Promise<string | null> {
    const name = normalizeChannelName(stream.name);
    if (name.length < 2) return null;
    const { items } = await this.deps.catalog.listChannels({ text: name, offset: 0, limit: 1 });
    return items[0]?.id ?? null;
  }
}

export function createProviderSyncWorker(deps: { catalog: OperatorCatalogRepository; sync: ProviderSyncService; pollIntervalMs?: number }): Worker {
  return {
    name: PROVIDER_SYNC_JOB,
    pollIntervalMs: deps.pollIntervalMs ?? 60_000,
    concurrency: 1,
    leaseMs: 2 * 60_000,
    claim: async (owner, now, leaseUntil) => {
      const provider = await deps.catalog.claimDueProvider(now, owner, leaseUntil);
      if (!provider) return null;
      return {
        label: `provider:${provider.id}`,
        heartbeat: (leaseOwner, until) => deps.catalog.heartbeatProvider(provider.id, leaseOwner, until),
        run: (lease) => deps.sync.run(provider, lease),
      };
    },
  };
}
