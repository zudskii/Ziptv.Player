import { idMatchKey, matchKey, retentionWindow } from '../../domain/epg/epg.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import type { Worker } from '../jobs/job-runner.js';
import type { TaskLease } from '../jobs/job-runner.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { EpgMappingRepository, GuideChannelRecord, GuideChannelRepository, GuideRecord, GuideRepository, ProgrammeRecord, ProgrammeRepository } from '../ports/epg-repository.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { GuideFetchError, type XmltvReader } from '../ports/xmltv.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { EPG_SYNC_JOB, type SourceEpgLinker } from './epg-linker.js';

const BATCH = 2_000;

export interface EpgSyncDeps {
  guides: GuideRepository;
  guideChannels: GuideChannelRepository;
  programmes: ProgrammeRepository;
  mappings: EpgMappingRepository;
  sources: SourceRepository;
  catalog: CatalogRepository;
  reader: XmltvReader;
  linker: SourceEpgLinker;
  secrets: SourceSecrets;
  notifications: NotificationService;
  cache: Cache;
  clock: Clock;
  logger: Logger;
  intervalHours: number;
  daysAhead: number;
}

/** What a guide sync must keep: everything linked or linkable to the guide's sources. */
interface WantedChannels {
  ids: Set<string>;
  names: Set<string>;
  maxCatchupDays: number;
}

/**
 * EpgSyncWorker pipeline: XMLTV URL → Downloader → Parser → Channel matcher → Database.
 *
 * Programmes are kept only for channels a source can link to, inside the retention window
 * (archive days back, `daysAhead` forward) — a 300 MB national guide shrinks to what is used.
 * The new generation becomes visible through a compare-and-set, then sources are re-linked.
 */
/** A real national guide has a few thousand channels; this bounds memory on hostile feeds. */
const MAX_GUIDE_CHANNELS = 100_000;

export class EpgSyncPipeline {
  constructor(private readonly deps: EpgSyncDeps) {}

  async run(guide: GuideRecord, lease: TaskLease): Promise<void> {
    const { guides, guideChannels, programmes, logger } = this.deps;
    const now = this.deps.clock.now();
    const log = logger.child({ guideId: guide.id });
    const generation = guide.claimedGeneration ?? guide.generation + 1;
    const ref = { guideId: guide.id, generation };

    try {
      const wanted = await this.wantedChannels(guide);
      const window = retentionWindow(now, wanted.maxCatchupDays, this.deps.daysAhead);
      await Promise.all([guideChannels.deleteGeneration(ref), programmes.deleteGeneration(ref)]);

      const channels = new Map<string, GuideChannelRecord>();
      const buffer: ProgrammeRecord[] = [];
      const stats = { programmes: 0, from: null as Date | null, to: null as Date | null };
      const keep = (id: string, names: string[]) =>
        wanted.ids.has(id.toLowerCase()) || names.some((name) => wanted.names.has(matchKey(normalizeChannelName(name)))) || wanted.names.has(idMatchKey(id));

      await this.deps.reader.read(this.deps.secrets.openGuideUrl(guide.url), lease.signal, {
        channel: (channel) => {
          if (!channels.has(channel.id) && channels.size >= MAX_GUIDE_CHANNELS) throw new GuideFetchError('too_large', `The guide declares more than ${MAX_GUIDE_CHANNELS} channels.`);
          channels.set(channel.id, { ...channel, kept: keep(channel.id, channel.names) });
        },
        programme: (programme) => {
          if (programme.stop.getTime() <= window.from.getTime() || programme.start.getTime() >= window.to.getTime()) return;
          let channel = channels.get(programme.channelId);
          if (!channel) {
            if (channels.size >= MAX_GUIDE_CHANNELS) throw new GuideFetchError('too_large', `The guide declares more than ${MAX_GUIDE_CHANNELS} channels.`);
            // Programmes of channels without a <channel> element (common in merged guides).
            channel = { id: programme.channelId, names: [], icon: null, kept: keep(programme.channelId, []) };
            channels.set(programme.channelId, channel);
          }
          if (!channel.kept) return;
          buffer.push(programme);
          stats.programmes++;
          if (!stats.from || programme.start < stats.from) stats.from = programme.start;
          if (!stats.to || programme.stop > stats.to) stats.to = programme.stop;
        },
        drain: async () => {
          lease.signal.throwIfAborted();
          if (buffer.length >= BATCH) await programmes.insertGeneration(ref, buffer.splice(0));
        },
      });
      if (buffer.length > 0) await programmes.insertGeneration(ref, buffer.splice(0));
      if (channels.size === 0) throw new GuideFetchError('invalid', 'The guide contains no channels.');
      await guideChannels.insertGeneration(ref, [...channels.values()]);
      lease.signal.throwIfAborted();

      const kept = [...channels.values()].filter((channel) => channel.kept).length;
      const committed = await guides.commitGeneration(guide.id, lease.owner, guide.generation, generation, {
        channels: channels.size,
        keptChannels: kept,
        programmes: stats.programmes,
        from: stats.from,
        to: stats.to,
      });
      if (!committed) {
        await Promise.all([guideChannels.deleteGeneration(ref), programmes.deleteGeneration(ref)]);
        log.warn('Guide generation swap lost a race; discarded');
        return;
      }
      await Promise.all([guideChannels.deleteOtherGenerations(ref), programmes.deleteOtherGenerations(ref)]);
      this.deps.cache.deleteByPrefix(`guide:${guide.id}:`);

      let linked = 0;
      for (const sourceId of guide.sourceIds) linked += (await this.deps.linker.relinkSource(sourceId)).linked;

      await guides.completeSync(guide.id, lease.owner, {
        status: 'idle',
        error: null,
        lastSuccessAt: now,
        nextSyncAt: new Date(this.deps.clock.now().getTime() + this.deps.intervalHours * 3600_000),
        consecutiveFailures: 0,
      });
      log.info({ generation, channels: channels.size, kept, programmes: stats.programmes, linked }, 'Guide synced');

      // Announce the first successful load and recoveries; routine refreshes stay quiet.
      if (guide.generation === 0 || guide.sync.error) {
        await this.deps.notifications.notify({
          ownerId: guide.ownerId,
          type: 'epg_updated',
          severity: 'success',
          title: 'EPG updated',
          body: `${guide.name}: ${stats.programmes.toLocaleString('en-US')} programmes for ${kept.toLocaleString('en-US')} channels`,
          link: '/guide',
          dedupeKey: `epg:${guide.id}`,
        });
      }
    } catch (error) {
      await Promise.all([guideChannels.deleteGeneration(ref), programmes.deleteGeneration(ref)]).catch(() => undefined);
      if (lease.signal.aborted) {
        log.info('Guide sync interrupted');
        return;
      }
      const message = error instanceof GuideFetchError ? error.message : 'The guide could not be read.';
      const failures = guide.sync.consecutiveFailures + 1;
      log.warn({ err: error }, 'Guide sync failed');
      await guides.completeSync(guide.id, lease.owner, {
        status: 'failed',
        error: message,
        nextSyncAt: new Date(this.deps.clock.now().getTime() + Math.min(this.deps.intervalHours * 3600_000, 15 * 60_000 * 2 ** Math.min(failures - 1, 6))),
        consecutiveFailures: failures,
      });
      if (!guide.sync.error) {
        await this.deps.notifications.notify({
          ownerId: guide.ownerId,
          type: 'epg_failed',
          severity: 'warning',
          title: 'EPG unavailable',
          body: `${guide.name}: ${message}`,
          link: '/sources',
          dedupeKey: `epg:${guide.id}`,
        });
      }
    }
  }

  private async wantedChannels(guide: GuideRecord): Promise<WantedChannels> {
    const wanted: WantedChannels = { ids: new Set(), names: new Set(), maxCatchupDays: 1 };
    for (const sourceId of guide.sourceIds) {
      const source = await this.deps.sources.findById(sourceId);
      if (!source || source.revision === 0 || source.ownerId !== guide.ownerId) continue;
      const [targets, mappings] = await Promise.all([
        this.deps.catalog.liveLinkTargets({ sourceId: source.id, revision: source.revision }),
        this.deps.mappings.listForSource(source.ownerId, source.id),
      ]);
      for (const target of targets) {
        if (target.tvgId) wanted.ids.add(target.tvgId.toLowerCase());
        if (target.xtreamEpgId) wanted.ids.add(target.xtreamEpgId.toLowerCase());
        if (target.nameKey) wanted.names.add(matchKey(target.nameKey));
        if (target.catchupDays) wanted.maxCatchupDays = Math.max(wanted.maxCatchupDays, target.catchupDays);
      }
      for (const mapping of mappings) if (mapping.guideId === guide.id) wanted.ids.add(mapping.epgChannelId.toLowerCase());
    }
    return wanted;
  }
}

export function createEpgSyncWorker(deps: { guides: GuideRepository; pipeline: EpgSyncPipeline; concurrency: number }): Worker {
  return {
    name: EPG_SYNC_JOB,
    pollIntervalMs: 60_000,
    concurrency: deps.concurrency,
    leaseMs: 3 * 60_000,
    claim: async (owner, now, leaseUntil) => {
      const guide = await deps.guides.claimDue(now, owner, leaseUntil);
      if (!guide) return null;
      return {
        label: `guide:${guide.id}`,
        heartbeat: (leaseOwner, until) => deps.guides.heartbeat(guide.id, leaseOwner, until),
        run: (lease) => deps.pipeline.run(guide, lease),
      };
    },
  };
}
