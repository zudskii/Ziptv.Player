import { createHash } from 'node:crypto';

import type { LiveChannelEntry } from '../../domain/catalog/model.js';
import { buildGuideIndex, matchChannel, sameLink, type GuideChannelIndex } from '../../domain/epg/epg.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { EpgMappingRepository, GuideChannelRepository, GuideRecord, GuideRepository, ProgrammeRepository } from '../ports/epg-repository.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import type { CatalogEpgLinker, JobKicker, SourceGuideSummary, SourceRemovalListener } from '../sources/hooks.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';
import { orderGuides } from './epg-mapper.js';

export const EPG_SYNC_JOB = 'epg-sync';
const INDEX_TTL_MS = 10 * 60_000;

export interface EpgLinkerDeps {
  sources: SourceRepository;
  catalog: CatalogRepository;
  guides: GuideRepository;
  guideChannels: GuideChannelRepository;
  programmes: ProgrammeRepository;
  mappings: EpgMappingRepository;
  secrets: SourceSecrets;
  jobs: JobKicker;
  cache: Cache;
  clock: Clock;
  logger: Logger;
}

export function guideUrlHash(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

/**
 * Channel matcher + guide lifecycle. Keeps three things consistent:
 *  - each source is attached to the guides its playlist/provider announces (url-tvg, xmltv.php);
 *  - each live channel of the current revision links to the best guide channel
 *    (manual mapping > tvg-id > normalised name);
 *  - a guide stores programmes for every linked channel (otherwise it is re-synced).
 * Link changes bump the source's `epgVersion`, so clients refetch channel lists.
 */
export class SourceEpgLinker implements CatalogEpgLinker, SourceRemovalListener {
  constructor(private readonly deps: EpgLinkerDeps) {}

  async linkBuild(source: SourceRecord, live: LiveChannelEntry[]): Promise<void> {
    const { indexes, manual } = await this.matchingContext(source);
    if (indexes.length === 0 && manual.size === 0) return;
    for (const channel of live) {
      channel.epg = matchChannel(
        { key: channel.key, tvgId: channel.tvgId, xtreamEpgId: channel.xtream?.epgChannelId ?? null, nameKey: normalizeChannelName(channel.name) },
        manual.get(channel.key),
        indexes,
      );
    }
  }

  async afterCommit(source: SourceRecord, epgUrls: string[]): Promise<void> {
    const { guides, secrets, clock } = this.deps;
    const announced = new Map(epgUrls.map((url) => [guideUrlHash(url), url]));

    for (const [hash, url] of announced) {
      const existing = await guides.findByUrlHash(source.ownerId, hash);
      if (existing) {
        if (!existing.sourceIds.includes(source.id)) {
          await guides.attachSource(existing.id, source.id);
          await this.relinkSource(source.id);
        }
        continue;
      }
      await guides.create({
        ownerId: source.ownerId,
        name: guideName(url),
        origin: source.type === 'xtream' ? 'xtream' : 'playlist',
        url: secrets.sealGuideUrl(url),
        urlHash: hash,
        host: safeHost(url),
        sourceIds: [source.id],
        queuedAt: clock.now(),
      });
      this.deps.jobs.kick(EPG_SYNC_JOB);
    }

    // Guides the source no longer announces stop applying to it (manual guides stay).
    const linked = await guides.listForSource(source.ownerId, source.id);
    const stale = linked.filter((guide) => guide.origin !== 'manual' && !announced.has(guide.urlHash)).map((guide) => guide.id);
    if (stale.length > 0) {
      await guides.detachSource(source.ownerId, source.id, stale);
      await this.relinkSource(source.id);
    }
    await this.removeOrphans(source.ownerId);
    await this.resyncGuidesMissingProgrammes(source.id);
  }

  async guideSummaries(ownerId: string): Promise<Map<string, SourceGuideSummary>> {
    const summaries = new Map<string, SourceGuideSummary>();
    for (const guide of await this.deps.guides.listByOwner(ownerId)) {
      for (const sourceId of guide.sourceIds) {
        const current = summaries.get(sourceId) ?? { guides: 0, version: '', syncing: false };
        summaries.set(sourceId, {
          guides: current.guides + 1,
          // Generations only grow: their sum identifies the programme data a source sees.
          version: `${current.version}${current.version ? '.' : ''}${guide.generation}`,
          syncing: current.syncing || guide.sync.status === 'queued' || guide.sync.status === 'running',
        });
      }
    }
    return summaries;
  }

  async onSourceRemoved(ownerId: string, sourceId: string): Promise<void> {
    await this.deps.guides.detachSource(ownerId, sourceId);
    await this.deps.mappings.deleteForSource(ownerId, sourceId);
    await this.removeOrphans(ownerId);
  }

  /**
   * Recomputes the links of a source's current revision (after a guide sync, a manual mapping
   * or guide changes) and writes only what changed.
   */
  async relinkSource(sourceId: string): Promise<{ changed: number; linked: number }> {
    const source = await this.deps.sources.findById(sourceId);
    if (!source || source.revision === 0) return { changed: 0, linked: 0 };
    const ref = { sourceId: source.id, revision: source.revision };
    const [targets, context] = await Promise.all([this.deps.catalog.liveLinkTargets(ref), this.matchingContext(source)]);

    let linked = 0;
    const changes: { key: string; epg: ReturnType<typeof matchChannel> }[] = [];
    for (const target of targets) {
      const next = matchChannel(target, context.manual.get(target.key), context.indexes);
      if (next) linked++;
      if (!sameLink(target.epg, next)) changes.push({ key: target.key, epg: next });
    }
    if (changes.length > 0) await this.deps.catalog.setLiveEpgLinks(ref, changes);
    await this.deps.sources.setEpgState(source.id, source.revision, linked, changes.length > 0);
    this.deps.cache.deleteByPrefix(sourceCachePrefix(source.id));
    if (changes.length > 0) this.deps.logger.info({ sourceId, changed: changes.length, linked }, 'EPG links updated');
    return { changed: changes.length, linked };
  }

  /**
   * Linked channels whose programmes the guide skipped (they were not linked at its last sync,
   * e.g. a new channel or a manual mapping) → sync that guide again.
   */
  async resyncGuidesMissingProgrammes(sourceId: string): Promise<void> {
    const source = await this.deps.sources.findById(sourceId);
    if (!source || source.revision === 0) return;
    const targets = await this.deps.catalog.liveLinkTargets({ sourceId: source.id, revision: source.revision });
    const byGuide = new Map<string, string[]>();
    for (const target of targets) {
      if (!target.epg) continue;
      const ids = byGuide.get(target.epg.guideId) ?? [];
      ids.push(target.epg.epgChannelId);
      byGuide.set(target.epg.guideId, ids);
    }
    for (const [guideId, ids] of byGuide) {
      const guide = await this.deps.guides.findById(guideId);
      if (!guide || guide.generation === 0) continue;
      const channels = await this.deps.guideChannels.find({ guideId, generation: guide.generation }, [...new Set(ids)]);
      if (channels.some((channel) => !channel.kept)) {
        await this.deps.guides.requestSync(guideId, this.deps.clock.now());
        this.deps.jobs.kick(EPG_SYNC_JOB);
      }
    }
  }

  /** Guides applicable to a source, best first, with their channel indexes (cached per generation). */
  async guidesFor(source: Pick<SourceRecord, 'id' | 'ownerId'>): Promise<GuideRecord[]> {
    return orderGuides(await this.deps.guides.listForSource(source.ownerId, source.id));
  }

  private async matchingContext(source: SourceRecord): Promise<{ indexes: GuideChannelIndex[]; manual: Map<string, { guideId: string; epgChannelId: string }> }> {
    const guides = (await this.guidesFor(source)).filter((guide) => guide.generation > 0);
    const [indexes, mappings] = await Promise.all([Promise.all(guides.map((guide) => this.index(guide))), this.deps.mappings.listForSource(source.ownerId, source.id)]);
    return { indexes, manual: new Map(mappings.map((mapping) => [mapping.channelKey, mapping])) };
  }

  private index(guide: GuideRecord): Promise<GuideChannelIndex> {
    return this.deps.cache.wrap(`guide:${guide.id}:${guide.generation}:index`, INDEX_TTL_MS, async () =>
      buildGuideIndex(guide.id, await this.deps.guideChannels.list({ guideId: guide.id, generation: guide.generation })),
    );
  }

  private async removeOrphans(ownerId: string): Promise<void> {
    for (const guide of await this.deps.guides.listOrphans(ownerId)) {
      await this.deleteGuideData(guide.id);
      await this.deps.guides.delete(guide.id);
    }
  }

  async deleteGuideData(guideId: string): Promise<void> {
    await Promise.all([this.deps.guideChannels.deleteGuide(guideId), this.deps.programmes.deleteGuide(guideId), this.deps.mappings.deleteForGuide(guideId)]);
    this.deps.cache.deleteByPrefix(`guide:${guideId}:`);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function guideName(url: string): string {
  try {
    const parsed = new URL(url);
    const file = safeDecode(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    // A file name like "epg.xml.gz" is a useful label; a long opaque segment is usually a token.
    const looksLikeToken = /^[A-Za-z0-9_-]{20,}$/.test(file.replace(/\.(xml|gz|xmltv)$/gi, ''));
    return file && !/\.php$/i.test(file) && !looksLikeToken ? `${parsed.hostname} · ${file}`.slice(0, 100) : `${parsed.hostname} guide`;
  } catch {
    return 'TV guide';
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
