import { aliasKeys } from '../../domain/operator/catalog.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import type { Worker } from '../jobs/job-runner.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { OperatorCatalogRepository, ProviderAdapters, ProviderConnection, ProviderRecord, ProviderStreamRecord } from '../ports/operator.js';
import type { NewSyncEvent, ProviderFeedRepository } from '../ports/provider-feed-repository.js';
import { canonicalGenres } from '../../domain/catalog/genres.js';
import { expandRights, freshnessProblem } from '../../domain/operator/vendor-feed.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { classifyFailure } from '../sources/source-sync.pipeline.js';
import type { ProviderConnections } from './provider-connections.js';

export const PROVIDER_SYNC_JOB = 'provider-sync';
const RETRY_MS = 15 * 60_000;
const MAX_SUGGESTIONS = 500;
const MAX_JOURNAL_ISSUES = 50;
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
      /** Journal, VOD, packages and feed-delivered rights (full-catalogue providers). */
      feeds?: ProviderFeedRepository;
      /** Rights or channels changed: viewer caches go, and viewings a revoked grant allowed stop. */
      onRightsChanged?: (revokedChannelIds: readonly string[]) => Promise<unknown> | void;
    },
  ) {}

  async run(provider: ProviderRecord, lease: { owner: string; signal: AbortSignal }): Promise<void> {
    const { catalog, clock } = this.deps;
    const log = this.deps.logger.child({ providerId: provider.id });
    const started = clock.now();
    try {
      const connection = await this.deps.connections.open(provider);
      const adapter = this.deps.adapters[provider.type];
      const outcome = adapter.fetchCatalog && this.deps.feeds ? await this.runFeed(provider, connection, lease.signal) : await this.runChannelList(provider, connection, lease.signal);
      const now = clock.now();
      const stats = await catalog.providerStats(provider.id);
      await catalog.completeProviderSync(provider.id, lease.owner, { ok: true, error: null, stats, nextAt: new Date(now.getTime() + provider.syncIntervalHours * 3600_000), now });
      await this.journal(provider.id, [{ level: 'info', code: 'sync_ok', message: `Synced in ${Math.round((now.getTime() - started.getTime()) / 100) / 10} s`, details: { ...outcome, pending: stats.pending } }]);
      log.info({ ...outcome, pending: stats.pending }, 'Provider synced');
    } catch (error) {
      if (lease.signal.aborted) return;
      const { message } = classifyFailure(error);
      const now = clock.now();
      log.warn({ err: error }, 'Provider sync failed');
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string' && error.name === 'VendorFeedError' ? String((error as { code: string }).code) : 'sync_failed';
      await this.journal(provider.id, [{ level: 'error', code, message: error instanceof Error && error.name === 'VendorFeedError' ? error.message : message }]);
      await catalog.completeProviderSync(provider.id, lease.owner, { ok: false, error: error instanceof Error && error.name === 'VendorFeedError' ? error.message : message, nextAt: new Date(now.getTime() + RETRY_MS), now });
    }
  }

  /** Channel-list providers (M3U, Xtream, mock): the whole list every time. */
  private async runChannelList(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<Record<string, number>> {
    const { catalog, clock } = this.deps;
    const { channels } = await this.deps.adapters[provider.type].listChannels(provider, connection, signal);
    signal.throwIfAborted();
    const now = clock.now();
    const upserted = await catalog.upsertStreams(
      provider.id,
      channels.map((channel) => ({ ...channel, locator: this.deps.secrets.sealLocator(channel.locator) })),
      now,
    );
    const gone = await catalog.markGone(provider.id, now);
    const matched = await this.match([...upserted.values()].filter((stream) => stream.status === 'pending'));
    if (gone > 0 || matched > 0) await this.deps.onRightsChanged?.([]);
    return { streams: channels.length, matched, gone };
  }

  /**
   * Full-catalogue providers (vendor feed): changes since the last cursor — channels with their
   * rights, movies and series, packages — then the feed grants of every affected channel are
   * brought in line with the feed. A refused feed (signature, provider, freshness) changes nothing.
   */
  private async runFeed(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<Record<string, number>> {
    const { catalog, clock, secrets } = this.deps;
    const feeds = this.deps.feeds!;
    const delta = await this.deps.adapters[provider.type].fetchCatalog!(provider, connection, provider.feed.cursor, signal);
    signal.throwIfAborted();
    const now = clock.now();
    const stale = freshnessProblem(delta.generatedAt, provider.feed.generatedAt, now);
    if (stale) throw Object.assign(new Error(`Feed refused: ${stale}.`), { name: 'VendorFeedError', code: 'stale_feed' });

    // Channels: same ingestion as channel lists (matching, review queue), plus their rights.
    const upserted = await catalog.upsertStreams(
      provider.id,
      delta.channels.map((channel) => ({ ...channel, locator: secrets.sealLocator(channel.locator) })),
      now,
    );
    await feeds.setStreamRights(provider.id, new Map(delta.channels.map((channel) => [channel.externalId, channel.rights ?? null])));
    const gone = delta.full ? await catalog.markGone(provider.id, now) : await feeds.markStreamsGone(provider.id, delta.deleted.channels);
    const matched = await this.match([...upserted.values()].filter((stream) => stream.status === 'pending'));

    // Movies, series, packages (stored; Phase 17 decides how they are sold).
    await feeds.upsertVod(
      provider.id,
      delta.vod.map((item) => ({
        ...item,
        genreIds: canonicalGenres(item.genres),
        locator: secrets.sealLocator(item.locator),
        episodes: item.episodes.map((episode) => ({ ...episode, locator: secrets.sealLocator(episode.locator) })),
      })),
      now,
    );
    const vodGone = await feeds.markVodGone(provider.id, delta.full ? { seenBefore: now } : { externalIds: delta.deleted.vod });
    await feeds.upsertPackages(provider.id, delta.packages, now);
    await feeds.markPackagesGone(provider.id, delta.full ? { seenBefore: now } : { externalIds: delta.deleted.packages });

    // Rights: every channel this provider feeds (or fed) gets its feed grants recomputed.
    const rights = await this.syncFeedGrants(provider, await feeds.feedChannels(provider.id));
    await feeds.setFeedPosition(provider.id, delta.cursor, delta.generatedAt);

    if (delta.issues.length > 0) {
      await this.journal(provider.id, [
        {
          level: 'warning',
          code: 'items_skipped',
          message: `${delta.issues.length} item(s) were skipped as invalid; the rest of the feed was applied.`,
          details: { issues: delta.issues.slice(0, MAX_JOURNAL_ISSUES), more: Math.max(0, delta.issues.length - MAX_JOURNAL_ISSUES) },
        },
      ]);
    }
    return {
      full: delta.full ? 1 : 0,
      channels: delta.channels.length,
      vod: delta.vod.length,
      packages: delta.packages.length,
      matched,
      gone,
      vodGone,
      grantsAdded: rights.added,
      grantsRevoked: rights.revoked,
      skipped: delta.issues.length,
    };
  }

  /**
   * Keeps feed-origin rights grants of these channels equal to the rights the provider's matched
   * streams carry. Called after a feed sync and after a stream is matched by hand.
   */
  async syncFeedGrants(provider: Pick<ProviderRecord, 'id' | 'slug' | 'contract'>, channelIds: readonly string[]): Promise<{ added: number; revoked: number }> {
    const feeds = this.deps.feeds;
    if (!feeds || channelIds.length === 0) return { added: 0, revoked: 0 };
    const now = this.deps.clock.now();
    let added = 0;
    const revokedChannels = new Set<string>();
    let revoked = 0;
    for (const channelId of channelIds) {
      const entry = (await feeds.streamRightsOfChannel(channelId)).find((item) => item.providerId === provider.id);
      const grants = (entry?.rights ?? []).length
        ? expandRights(entry!.rights!).map(({ territory, right }) => ({
            territory,
            deviceClasses: right.devices,
            businessModels: right.models,
            startAt: right.start,
            endAt: right.end,
            catchupDays: right.catchupDays,
            maxQuality: right.maxQuality,
          }))
        : [];
      const result = await feeds.replaceFeedGrants(channelId, provider.id, provider.contract.ref ?? `feed:${provider.slug}`, grants, now);
      added += result.added;
      revoked += result.revoked.length;
      if (result.revoked.length > 0) revokedChannels.add(channelId);
    }
    if (added > 0 || revoked > 0) await this.deps.onRightsChanged?.([...revokedChannels]);
    return { added, revoked };
  }

  private async journal(providerId: string, events: NewSyncEvent[]): Promise<void> {
    try {
      await this.deps.feeds?.recordEvents(providerId, events, this.deps.clock.now());
    } catch (error) {
      // The journal must never turn a good sync into a failed one.
      this.deps.logger.warn({ err: error, providerId }, 'Provider sync journal could not be written');
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

  /** After a stream was matched by hand: the channel takes on the rights the provider's feed gives it. */
  async afterManualMatch(stream: ProviderStreamRecord, channelId: string | null, previousChannelId: string | null): Promise<void> {
    if (!this.deps.feeds) return;
    const provider = await this.deps.catalog.findProvider(stream.providerId);
    if (!provider || provider.type !== 'vendor_feed') return;
    await this.syncFeedGrants(provider, [...new Set([channelId, previousChannelId].filter((id): id is string => Boolean(id)))]);
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
