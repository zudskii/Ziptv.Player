import type {
  AddGuideRequest,
  ChannelEpgLinkDto,
  ChannelScheduleDto,
  EpgSearchItemDto,
  EpgSearchResultDto,
  GuideChannelOptionDto,
  GuideDto,
  GuideSourceDto,
  NowNextDto,
  NowNextListDto,
  SetEpgMappingRequest,
  UpdateGuideRequest,
} from '@ziptv/contracts';

import { nowAndNext } from '../../domain/epg/epg.js';
import { queryTerms } from '../../domain/shared/text.js';
import { toChannelDto } from '../catalog/catalog-mapper.js';
import type { LiveCatalogService } from '../catalog/live.service.js';
import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { LiveChannelSummary } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { EpgMappingRepository, GuideChannelRepository, GuideRecord, GuideRepository, ProgrammeQuery, ProgrammeRecord, ProgrammeRepository } from '../ports/epg-repository.js';
import type { MediaUrls } from '../ports/media-urls.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import type { UrlPolicy } from '../ports/url-policy.js';
import type { JobKicker } from '../sources/hooks.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { catalogVersion } from '../sources/source-mapper.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';
import { EPG_SYNC_JOB, guideUrlHash, type SourceEpgLinker } from './epg-linker.js';
import { epgIconUrl, toGuideSourceDto, toProgrammeDto } from './epg-mapper.js';

const HOUR = 3600_000;
const NOW_NEXT_TTL_MS = 60_000;
const NOW_NEXT_AHEAD_MS = 12 * HOUR;
/** A local "day" is 25 h on the autumn DST change; the grid asks for a day + 2 h. */
const MAX_GUIDE_SPAN_MS = 28 * HOUR;
const MAX_SCHEDULE_SPAN_MS = 9 * 24 * HOUR;
const MAX_GUIDE_ROWS = 100;
const SEARCH_LIMIT = 40;

export interface EpgServiceDeps {
  live: LiveCatalogService;
  sources: SourceRepository;
  guides: GuideRepository;
  guideChannels: GuideChannelRepository;
  programmes: ProgrammeRepository;
  mappings: EpgMappingRepository;
  linker: SourceEpgLinker;
  secrets: SourceSecrets;
  media: MediaUrls;
  urlPolicy: UrlPolicy;
  jobs: JobKicker;
  cache: Cache;
  clock: Clock;
  /** Viewer's guide time shift (Settings → EPG), ms. */
  timeShift?: (viewer: Viewer) => Promise<number>;
  /** `proxy`: every icon goes through the image proxy (no provider hosts reach clients). */
  delivery?: 'auto' | 'proxy';
}

export type NowNextRaw = Map<string, { now: ProgrammeRecord | null; next: ProgrammeRecord | null }>;

/** EPG API: now/next, channel schedules (mini guide), TV Guide grid, programme search, guides & mapping. */
export class EpgService {
  private readonly proxyAll: boolean;

  constructor(private readonly deps: EpgServiceDeps) {
    this.proxyAll = deps.delivery === 'proxy';
  }

  // --- reads -------------------------------------------------------------------------------

  async nowNext(viewer: Viewer, sourceId: string): Promise<NowNextListDto> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    const now = this.deps.clock.now();
    const [summaries, raw, shift] = await Promise.all([this.deps.live.summaries(source), this.rawNowNext(source, now), this.shift(viewer)]);
    const items: Record<string, NowNextDto> = {};
    for (const channel of summaries) {
      const entry = raw.get(channel.key);
      if (!entry || isHiddenForViewer(viewer, channel)) continue;
      const context = { catchupDays: channel.catchup?.days ?? null, now, media: this.deps.media, shiftMs: shift, proxyAll: this.proxyAll };
      items[channel.key] = {
        now: entry.now ? toProgrammeDto(entry.now, context) : null,
        next: entry.next ? toProgrammeDto(entry.next, context) : null,
      };
    }
    return { sourceId: source.id, catalogVersion: catalogVersion(source), generatedAt: now.toISOString(), items };
  }

  /** Raw now/next of every linked channel of a source (Home "Live Now"). Cached per minute. */
  nowNextMap(source: SourceRecord): Promise<NowNextRaw> {
    return this.rawNowNext(source, this.deps.clock.now());
  }

  async channelSchedule(viewer: Viewer, sourceId: string, key: string, range: { from?: Date; to?: Date }): Promise<ChannelScheduleDto> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    const channel = (await this.deps.live.summaries(source)).find((item) => item.key === key);
    if (!channel || isHiddenForViewer(viewer, channel)) throw AppError.notFound('Channel');
    const now = this.deps.clock.now();
    const catchupDays = channel.catchup?.days ?? 0;
    const from = range.from ?? new Date(now.getTime() - (catchupDays > 0 ? catchupDays * 24 * HOUR : 3 * HOUR));
    const to = range.to ?? new Date(now.getTime() + 24 * HOUR);
    if (to.getTime() - from.getTime() > MAX_SCHEDULE_SPAN_MS || to <= from) throw AppError.validation('The requested time range is too large.');

    const shift = await this.shift(viewer);
    const programmes = channel.epg ? await this.window(source, [channel], new Date(from.getTime() - shift), new Date(to.getTime() - shift)) : new Map<string, ProgrammeRecord[]>();
    const context = { catchupDays: channel.catchup?.days ?? null, now, media: this.deps.media, shiftMs: shift, proxyAll: this.proxyAll };
    return {
      sourceId: source.id,
      key,
      from: from.toISOString(),
      to: to.toISOString(),
      programmes: (programmes.get(channel.key) ?? []).map((programme) => toProgrammeDto(programme, context)),
    };
  }

  async guide(viewer: Viewer, query: { sourceId: string; from: Date; to: Date; group?: string; offset: number; limit: number }): Promise<GuideDto> {
    if (query.to <= query.from || query.to.getTime() - query.from.getTime() > MAX_GUIDE_SPAN_MS) {
      throw AppError.validation('The guide shows at most 28 hours at a time.');
    }
    const source = await this.deps.live.requireSource(viewer, query.sourceId);
    const summaries = await this.deps.live.summaries(source);
    const visible = this.deps.live
      .visible(viewer, source.id, summaries)
      .filter((channel) => !channel.unplayableReason && (!query.group || (query.group === '\u0000none' ? channel.groups.length === 0 : channel.groups.includes(query.group))));
    const limit = Math.min(MAX_GUIDE_ROWS, Math.max(1, query.limit));
    const page = visible.slice(query.offset, query.offset + limit);
    const byKey = new Map(summaries.map((channel) => [channel.key, channel]));
    const shift = await this.shift(viewer);
    const programmes = await this.window(
      source,
      page.map((channel) => byKey.get(channel.key)!).filter(Boolean),
      new Date(query.from.getTime() - shift),
      new Date(query.to.getTime() - shift),
    );
    const now = this.deps.clock.now();
    return {
      sourceId: source.id,
      catalogVersion: catalogVersion(source),
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      total: visible.length,
      offset: query.offset,
      rows: page.map((channel) => ({
        channel,
        programmes: (programmes.get(channel.key) ?? []).map((programme) =>
          toProgrammeDto(programme, { catchupDays: channel.catchupDays, now, media: this.deps.media, shiftMs: shift, proxyAll: this.proxyAll }),
        ),
      })),
    };
  }

  async search(viewer: Viewer, query: string, limit = SEARCH_LIMIT): Promise<EpgSearchResultDto> {
    const terms = queryTerms(query);
    if (terms.length === 0) return { query, items: [] };
    const now = this.deps.clock.now();
    const sources = (await this.deps.sources.listByOwner(viewer.userId)).filter((source) => source.revision > 0);
    const guides = (await this.deps.guides.listByOwner(viewer.userId)).filter((guide) => guide.generation > 0);
    if (sources.length === 0 || guides.length === 0) return { query, items: [] };

    // (guide, epg channel) → the live channels showing it.
    const owners = new Map<string, { source: SourceRecord; channel: LiveChannelSummary }>();
    for (const source of sources) {
      for (const channel of await this.deps.live.summaries(source)) {
        if (!channel.epg || isHiddenForViewer(viewer, channel) || channel.unplayableReason) continue;
        const id = `${channel.epg.guideId}|${channel.epg.epgChannelId}`;
        if (!owners.has(id)) owners.set(id, { source, channel });
      }
    }
    const refs = guides.map((guide) => ({ guideId: guide.id, generation: guide.generation }));
    // On now / upcoming (soonest first) and archive (most recent first) separately: yesterday's
    // reruns of a common title must not crowd out what is on today.
    const [current, archive] = await Promise.all([
      this.deps.programmes.search(refs, terms, now, new Date(now.getTime() + 8 * 24 * HOUR), limit * 4, 'asc'),
      this.deps.programmes.search(refs, terms, new Date(now.getTime() - 7 * 24 * HOUR), now, limit * 4, 'desc'),
    ]);
    const found = [...current, ...archive.filter((programme) => programme.stop.getTime() <= now.getTime())];
    const shift = await this.shift(viewer);
    const items: EpgSearchItemDto[] = [];
    for (const programme of found) {
      const owner = owners.get(`${programme.guideId}|${programme.channelId}`);
      if (!owner) continue;
      const locked = this.deps.live.isLocked(viewer, owner.source.id, owner.channel);
      if (locked && viewer.kids) continue;
      const dto = toProgrammeDto(programme, { catchupDays: owner.channel.catchup?.days ?? null, now, media: this.deps.media, shiftMs: shift, proxyAll: this.proxyAll });
      // Past programmes are only useful when they can be replayed.
      if (new Date(dto.end) <= now && !dto.catchup) continue;
      items.push({ sourceId: owner.source.id, sourceName: owner.source.name, channel: toChannelDto(owner.channel, locked, this.deps.live.artwork), programme: dto });
    }
    // On now first, then upcoming, then archive (most recent first).
    const rank = (item: EpgSearchItemDto) => {
      const start = new Date(item.programme.start).getTime();
      const end = new Date(item.programme.end).getTime();
      if (start <= now.getTime() && end > now.getTime()) return [0, start];
      if (start > now.getTime()) return [1, start];
      return [2, -start];
    };
    items.sort((a, b) => {
      const [ra, ta] = rank(a);
      const [rb, tb] = rank(b);
      return ra! - rb! || ta! - tb!;
    });
    return { query, items: items.slice(0, limit) };
  }

  // --- guides (EPG sources) ------------------------------------------------------------------

  async listGuides(ownerId: string): Promise<GuideSourceDto[]> {
    return (await this.deps.guides.listByOwner(ownerId)).map(toGuideSourceDto);
  }

  async addGuide(ownerId: string, input: AddGuideRequest): Promise<GuideSourceDto> {
    const url = new URL(input.url);
    try {
      this.deps.urlPolicy.assertAllowed(url);
    } catch {
      throw new AppError('UPSTREAM_BLOCKED', 422, 'This URL points to a private or local network address and cannot be used.');
    }
    const sources = await this.deps.sources.listByOwner(ownerId);
    const sourceIds = input.sourceIds?.length ? input.sourceIds.filter((id) => sources.some((source) => source.id === id)) : sources.map((source) => source.id);
    const hash = guideUrlHash(url.href);
    const existing = await this.deps.guides.findByUrlHash(ownerId, hash);
    if (existing) {
      const merged = [...new Set([...existing.sourceIds, ...sourceIds])];
      const updated = await this.deps.guides.update(existing.id, ownerId, { name: input.name ?? existing.name, sourceIds: merged });
      await this.relink(merged);
      return toGuideSourceDto(updated ?? existing);
    }
    const created = await this.deps.guides.create({
      ownerId,
      name: (input.name || `${url.hostname} guide`).slice(0, 100),
      origin: 'manual',
      url: this.deps.secrets.sealGuideUrl(url.href),
      urlHash: hash,
      host: url.host,
      sourceIds,
      queuedAt: this.deps.clock.now(),
    });
    this.deps.jobs.kick(EPG_SYNC_JOB);
    return toGuideSourceDto(created);
  }

  async updateGuide(ownerId: string, guideId: string, patch: UpdateGuideRequest): Promise<GuideSourceDto> {
    const guide = await this.requireGuide(ownerId, guideId);
    let sourceIds: string[] | undefined;
    if (patch.sourceIds) {
      const owned = new Set((await this.deps.sources.listByOwner(ownerId)).map((source) => source.id));
      sourceIds = patch.sourceIds.filter((id) => owned.has(id));
    }
    const updated = await this.deps.guides.update(guide.id, ownerId, { ...(patch.name ? { name: patch.name } : {}), ...(sourceIds ? { sourceIds } : {}) });
    if (!updated) throw AppError.notFound('Guide');
    if (sourceIds) {
      await this.relink([...new Set([...guide.sourceIds, ...sourceIds])]);
      // Newly attached sources may link channels the guide skipped.
      await this.deps.guides.requestSync(guide.id, this.deps.clock.now());
      this.deps.jobs.kick(EPG_SYNC_JOB);
    }
    return toGuideSourceDto(updated);
  }

  async removeGuide(ownerId: string, guideId: string): Promise<void> {
    const guide = await this.requireGuide(ownerId, guideId);
    if (guide.origin !== 'manual') {
      throw new AppError('CONFLICT', 409, 'This guide is announced by your source and managed automatically. Remove the source instead.');
    }
    await this.deps.guides.delete(guide.id);
    await this.deps.linker.deleteGuideData(guide.id);
    await this.relink(guide.sourceIds);
  }

  async syncGuide(ownerId: string, guideId: string): Promise<GuideSourceDto> {
    const guide = await this.requireGuide(ownerId, guideId);
    const queued = await this.deps.guides.requestSync(guide.id, this.deps.clock.now());
    this.deps.jobs.kick(EPG_SYNC_JOB);
    return toGuideSourceDto(queued ?? guide);
  }

  // --- mapping ---------------------------------------------------------------------------------

  async link(viewer: Viewer, sourceId: string, channelKey: string): Promise<ChannelEpgLinkDto> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    const channel = (await this.deps.live.summaries(source)).find((item) => item.key === channelKey);
    if (!channel) throw AppError.notFound('Channel');
    if (!channel.epg) return { sourceId, channelKey, link: null };
    const guide = await this.deps.guides.findById(channel.epg.guideId);
    const [epgChannel] = guide ? await this.deps.guideChannels.find({ guideId: guide.id, generation: guide.generation }, [channel.epg.epgChannelId]) : [];
    return {
      sourceId,
      channelKey,
      link: {
        guideId: channel.epg.guideId,
        guideName: guide?.name ?? 'Guide',
        epgChannelId: channel.epg.epgChannelId,
        epgChannelName: epgChannel?.names[0] ?? channel.epg.epgChannelId,
        match: channel.epg.match,
      },
    };
  }

  async setMapping(viewer: Viewer, input: SetEpgMappingRequest): Promise<ChannelEpgLinkDto> {
    const source = await this.deps.live.requireSource(viewer, input.sourceId);
    const channel = (await this.deps.live.summaries(source)).find((item) => item.key === input.channelKey);
    if (!channel) throw AppError.notFound('Channel');
    const guide = await this.requireGuide(viewer.userId, input.guideId);
    const [target] = await this.deps.guideChannels.find({ guideId: guide.id, generation: guide.generation }, [input.epgChannelId]);
    if (!target) throw AppError.notFound('Guide channel');
    if (!guide.sourceIds.includes(source.id)) await this.deps.guides.attachSource(guide.id, source.id);

    await this.deps.mappings.set(viewer.userId, source.id, { channelKey: input.channelKey, guideId: guide.id, epgChannelId: target.id });
    await this.deps.linker.relinkSource(source.id);
    if (!target.kept) {
      // The guide skipped this channel's programmes at its last sync: fetch them now.
      await this.deps.guides.requestSync(guide.id, this.deps.clock.now());
      this.deps.jobs.kick(EPG_SYNC_JOB);
    }
    return this.link(viewer, source.id, input.channelKey);
  }

  async removeMapping(viewer: Viewer, sourceId: string, channelKey: string): Promise<ChannelEpgLinkDto> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    await this.deps.mappings.remove(viewer.userId, source.id, channelKey);
    await this.deps.linker.relinkSource(source.id);
    await this.deps.linker.resyncGuidesMissingProgrammes(source.id);
    return this.link(viewer, source.id, channelKey);
  }

  async searchGuideChannels(viewer: Viewer, sourceId: string, query: string): Promise<GuideChannelOptionDto[]> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    const linked = await this.deps.linker.guidesFor(source);
    const manual = (await this.deps.guides.listByOwner(viewer.userId)).filter((guide) => guide.origin === 'manual' && !linked.some((item) => item.id === guide.id));
    const guides = [...linked, ...manual].filter((guide) => guide.generation > 0);
    const names = new Map(guides.map((guide) => [guide.id, guide.name]));
    const found = await this.deps.guideChannels.search(
      guides.map((guide) => ({ guideId: guide.id, generation: guide.generation })),
      queryTerms(query),
      50,
    );
    return found.map((channel) => ({
      guideId: channel.guideId,
      guideName: names.get(channel.guideId) ?? 'Guide',
      id: channel.id,
      name: channel.names[0] ?? channel.id,
      icon: epgIconUrl(channel.icon, this.deps.media, this.proxyAll),
    }));
  }

  // ---------------------------------------------------------------------------------------------

  private async rawNowNext(source: SourceRecord, now: Date): Promise<NowNextRaw> {
    const minute = Math.floor(now.getTime() / 60_000);
    return this.deps.cache.wrap(`${sourceCachePrefix(source.id)}nownext:${catalogVersion(source)}:${minute}`, NOW_NEXT_TTL_MS, async () => {
      const linked = (await this.deps.live.summaries(source)).filter((channel) => channel.epg);
      // Two rows per channel (what is on, what is next) instead of every programme of the next hours.
      const programmes = await this.window(source, linked, now, new Date(now.getTime() + NOW_NEXT_AHEAD_MS), 2);
      const result: NowNextRaw = new Map();
      for (const channel of linked) {
        const list = programmes.get(channel.key);
        if (!list || list.length === 0) continue;
        const entry = nowAndNext(list, now);
        if (entry.now || entry.next) result.set(channel.key, entry);
      }
      return result;
    });
  }

  /** Programmes of the given live channels within [from, to), keyed by channel key. */
  private async window(source: SourceRecord, channels: LiveChannelSummary[], from: Date, to: Date, perChannel?: number): Promise<Map<string, ProgrammeRecord[]>> {
    const guides = new Map((await this.deps.guides.listForSource(source.ownerId, source.id)).map((guide) => [guide.id, guide]));
    const queries = new Map<string, ProgrammeQuery>();
    const seenIds = new Map<string, Set<string>>();
    const owners = new Map<string, string[]>();
    for (const channel of channels) {
      if (!channel.epg) continue;
      const guide = guides.get(channel.epg.guideId);
      if (!guide || guide.generation === 0) continue;
      const query = queries.get(guide.id) ?? { guideId: guide.id, generation: guide.generation, channelIds: [] };
      const seen = seenIds.get(guide.id) ?? new Set<string>();
      if (!seen.has(channel.epg.epgChannelId)) {
        seen.add(channel.epg.epgChannelId);
        query.channelIds.push(channel.epg.epgChannelId);
      }
      seenIds.set(guide.id, seen);
      queries.set(guide.id, query);
      const id = `${guide.id}|${channel.epg.epgChannelId}`;
      owners.set(id, [...(owners.get(id) ?? []), channel.key]);
    }
    const result = new Map<string, ProgrammeRecord[]>();
    const rows = perChannel ? await this.deps.programmes.upcoming([...queries.values()], from, perChannel) : await this.deps.programmes.window([...queries.values()], from, to);
    for (const programme of rows) {
      for (const key of owners.get(`${programme.guideId}|${programme.channelId}`) ?? []) {
        const list = result.get(key) ?? [];
        list.push(programme);
        result.set(key, list);
      }
    }
    for (const list of result.values()) list.sort((a, b) => a.start.getTime() - b.start.getTime());
    return result;
  }

  private async relink(sourceIds: string[]): Promise<void> {
    for (const sourceId of sourceIds) await this.deps.linker.relinkSource(sourceId);
  }

  private async requireGuide(ownerId: string, guideId: string): Promise<GuideRecord> {
    const guide = this.deps.guides.isValidId(guideId) ? await this.deps.guides.findOwned(guideId, ownerId) : null;
    if (!guide) throw AppError.notFound('Guide');
    return guide;
  }

  private shift(viewer: Viewer): Promise<number> {
    return this.deps.timeShift ? this.deps.timeShift(viewer) : Promise.resolve(0);
  }
}

