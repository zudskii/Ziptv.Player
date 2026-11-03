import { createHash } from 'node:crypto';

import type { CreateOperatorGuideRequest, EpgCoverageDto, EpgCoverageStatus, OperatorGuideChannelDto, OperatorGuideDto, OperatorNowNextDto, UpdateOperatorGuideRequest } from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { idMatchKey, matchKey } from '../../domain/epg/epg.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import { actorOf, type AdminContext, type StaffPrincipal } from '../admin/principal.js';
import { AppError } from '../errors.js';
import type { TaskLease, Worker } from '../jobs/job-runner.js';
import type { AdminUnitOfWork } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { ChannelEpgRecord, OperatorEpgRepository, OperatorGuideRecord, OperatorProgrammeRecord } from '../ports/operator-epg.js';
import { GuideFetchError, type XmltvReader } from '../ports/xmltv.js';
import type { JobKicker } from '../sources/hooks.js';
import type { SourceSecrets } from '../sources/secrets.js';

export const OPERATOR_EPG_JOB = 'operator-epg-sync';
const HOUR = 3_600_000;
const BATCH = 2_000;
const MAX_GUIDE_CHANNELS = 100_000;
/** A gap longer than this in the next 24 h counts as a hole in the schedule. */
const GAP_MS = HOUR;
const ENDS_SOON_MS = 12 * HOUR;

/**
 * Programme guide of the operator catalog (Phase 9.7). Licensed XMLTV guides are synced in
 * generations (like a source revision); master channels are mapped to guide channels
 * automatically by their aliases (tvg-id first, then normalized name; the guide with the lower
 * priority number wins) or by hand in the console (a manual mapping is never overwritten). Only
 * programmes of channels the catalog can use are kept.
 */
export class OperatorEpgService {
  constructor(
    private readonly deps: {
      epg: OperatorEpgRepository;
      reader: XmltvReader;
      secrets: Pick<SourceSecrets, 'sealGuideUrl' | 'openGuideUrl'>;
      urlPolicy: { assertAllowed(url: URL): void | Promise<void> };
      uow: AdminUnitOfWork;
      clock: Clock;
      logger: Logger;
      jobs?: JobKicker;
      daysAhead: number;
    },
  ) {}

  // --- guides (console) --------------------------------------------------------------------------

  async guides(): Promise<OperatorGuideDto[]> {
    return (await this.deps.epg.listGuides()).map((guide) => toGuideDto(guide, guide.mappedChannels));
  }

  async createGuide(actor: StaffPrincipal, input: CreateOperatorGuideRequest, context: AdminContext): Promise<OperatorGuideDto> {
    const url = await this.checkUrl(input.url);
    const now = this.deps.clock.now();
    const id = this.deps.epg.newId();
    try {
      await this.deps.uow.run(async (tx) => {
        await tx.operatorEpg.createGuide({ id, name: input.name.trim(), url: this.deps.secrets.sealGuideUrl(url.href), urlHash: hashUrl(url.href), host: url.host, priority: input.priority ?? 100, syncIntervalHours: input.syncIntervalHours ?? 12, now });
        await tx.audit.append({ ...actorOf(actor, context), occurredAt: now, action: 'epg.guide_created', targetType: 'operator_guide', targetId: id, beforeHash: null, afterHash: null, details: { name: input.name.trim(), host: url.host } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('CONFLICT', 409, 'This guide is already configured.');
      throw error;
    }
    this.deps.jobs?.kick(OPERATOR_EPG_JOB);
    return toGuideDto((await this.deps.epg.findGuide(id))!, 0);
  }

  async updateGuide(actor: StaffPrincipal, id: string, input: UpdateOperatorGuideRequest, context: AdminContext): Promise<OperatorGuideDto> {
    const before = await this.requireGuide(id);
    const url = input.url !== undefined ? await this.checkUrl(input.url) : null;
    const now = this.deps.clock.now();
    try {
      await this.deps.uow.run(async (tx) => {
        await tx.operatorEpg.updateGuide(
          id,
          {
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(url ? { url: this.deps.secrets.sealGuideUrl(url.href), urlHash: hashUrl(url.href), host: url.host } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.syncIntervalHours !== undefined ? { syncIntervalHours: input.syncIntervalHours } : {}),
          },
          now,
        );
        await tx.audit.append({ ...actorOf(actor, context), occurredAt: now, action: 'epg.guide_updated', targetType: 'operator_guide', targetId: id, beforeHash: stateHash(guideState(before)), afterHash: null, details: { changes: Object.keys(input), ...(url ? { host: url.host } : {}) } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('CONFLICT', 409, 'This guide is already configured.');
      throw error;
    }
    if (url || (input.status === 'active' && before.status !== 'active')) await this.syncNow(actor, id, context, false);
    else if (input.priority !== undefined || input.status !== undefined) await this.automap();
    return (await this.guides()).find((guide) => guide.id === id)!;
  }

  async deleteGuide(actor: StaffPrincipal, id: string, context: AdminContext): Promise<void> {
    const guide = await this.requireGuide(id);
    await this.deps.uow.run(async (tx) => {
      await tx.operatorEpg.deleteGuide(id);
      await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action: 'epg.guide_deleted', targetType: 'operator_guide', targetId: id, beforeHash: stateHash(guideState(guide)), afterHash: null, details: { name: guide.name } });
    });
    // Channels it served may be served by another guide.
    await this.automap();
  }

  async syncNow(actor: StaffPrincipal, id: string, context: AdminContext, audit = true): Promise<void> {
    await this.requireGuide(id);
    await this.deps.epg.requestSync(id, this.deps.clock.now());
    if (audit) await this.deps.uow.run((tx) => tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action: 'epg.guide_sync_requested', targetType: 'operator_guide', targetId: id, beforeHash: null, afterHash: null, details: {} }).then(() => undefined));
    this.deps.jobs?.kick(OPERATOR_EPG_JOB);
  }

  // --- mapping and coverage -------------------------------------------------------------------

  async searchGuideChannels(query: { guideId?: string | undefined; text: string; limit: number }): Promise<OperatorGuideChannelDto[]> {
    return this.deps.epg.searchGuideChannels(query);
  }

  async setMapping(actor: StaffPrincipal, channelId: string, input: { guideId: string; epgChannelId: string }, context: AdminContext): Promise<void> {
    if (!(await this.deps.epg.activeChannels()).some((channel) => channel.id === channelId)) throw AppError.notFound('Channel');
    if (!(await this.deps.epg.guideChannelExists(input.guideId, input.epgChannelId))) throw AppError.validation('That guide does not list this channel id (sync the guide first).');
    const now = this.deps.clock.now();
    await this.deps.uow.run(async (tx) => {
      await tx.operatorEpg.setMapping({ channelId, guideId: input.guideId, epgChannelId: input.epgChannelId, method: 'manual' }, now);
      await tx.audit.append({ ...actorOf(actor, context), occurredAt: now, action: 'epg.mapping_set', targetType: 'channel', targetId: channelId, beforeHash: null, afterHash: null, details: { guideId: input.guideId, epgChannelId: input.epgChannelId } });
    });
    // Programmes of a newly mapped id arrive with the guide's next sync.
    await this.deps.epg.requestSync(input.guideId, now);
    this.deps.jobs?.kick(OPERATOR_EPG_JOB);
  }

  /** Back to automatic matching. */
  async clearMapping(actor: StaffPrincipal, channelId: string, context: AdminContext): Promise<void> {
    await this.deps.uow.run(async (tx) => {
      await tx.operatorEpg.deleteMapping(channelId);
      await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action: 'epg.mapping_cleared', targetType: 'channel', targetId: channelId, beforeHash: null, afterHash: null, details: {} });
    });
    await this.automap();
  }

  async coverage(): Promise<EpgCoverageDto> {
    const now = this.deps.clock.now();
    const horizon = new Date(now.getTime() + 24 * HOUR);
    const [channels, mappings, guides, ends] = await Promise.all([this.deps.epg.activeChannels(), this.deps.epg.mappings(), this.deps.epg.listGuides(), this.deps.epg.scheduleEnds()]);
    const byChannel = new Map(mappings.map((mapping) => [mapping.channelId, mapping]));
    const guideNames = new Map(guides.map((guide) => [guide.id, guide.name]));
    const programmes = await this.deps.epg.programmesFor([...byChannel.keys()], now, horizon);
    const grouped = new Map<string, { start: Date; stop: Date }[]>();
    for (const programme of programmes) grouped.set(programme.channelId, [...(grouped.get(programme.channelId) ?? []), programme]);

    const summary: Record<EpgCoverageStatus, number> = { ok: 0, unmapped: 0, no_data: 0, ends_soon: 0, gaps: 0 };
    const rows = channels.map((channel) => {
      const mapping = byChannel.get(channel.id) ?? null;
      const list = grouped.get(channel.id) ?? [];
      const gap = gapMs(list, now, horizon);
      const end = ends.get(channel.id) ?? null;
      const status: EpgCoverageStatus = !mapping ? 'unmapped' : list.length === 0 ? 'no_data' : gap > GAP_MS ? 'gaps' : !end || end.getTime() - now.getTime() < ENDS_SOON_MS ? 'ends_soon' : 'ok';
      summary[status] += 1;
      return {
        channelId: channel.id,
        name: channel.name,
        status,
        mapping: mapping ? { guideId: mapping.guideId, guideName: guideNames.get(mapping.guideId) ?? '', epgChannelId: mapping.epgChannelId, method: mapping.method } : null,
        programmes24h: list.length,
        scheduleEndsAt: end?.toISOString() ?? null,
        gapMinutes24h: mapping ? Math.round(gap / 60_000) : 0,
      };
    });
    return { generatedAt: now.toISOString(), summary, channels: rows };
  }

  // --- viewers ----------------------------------------------------------------------------------

  /** Now and next on the given (already authorized for the viewer) operator channels. */
  async nowNext(channelIds: string[]): Promise<OperatorNowNextDto[]> {
    const now = this.deps.clock.now();
    const programmes = await this.deps.epg.programmesFor(channelIds, now, new Date(now.getTime() + 12 * HOUR));
    const grouped = new Map<string, (OperatorProgrammeRecord & { channelId: string })[]>();
    for (const programme of programmes) grouped.set(programme.channelId, [...(grouped.get(programme.channelId) ?? []), programme]);
    return channelIds.map((channelId) => {
      const list = grouped.get(channelId) ?? [];
      const current = list.find((p) => p.start <= now && p.stop > now) ?? null;
      const next = list.find((p) => p.start >= (current?.stop ?? now)) ?? null;
      return { channelId, now: current ? toProgramme(current) : null, next: next ? toProgramme(next) : null };
    });
  }

  // --- sync ---------------------------------------------------------------------------------------

  async run(guide: OperatorGuideRecord, lease: TaskLease): Promise<void> {
    const { epg } = this.deps;
    const log = this.deps.logger.child({ guideId: guide.id });
    const generation = guide.claimedGeneration ?? guide.generation + 1;
    const now = this.deps.clock.now();
    const window = { from: new Date(now.getTime() - 24 * HOUR), to: new Date(now.getTime() + this.deps.daysAhead * 24 * HOUR) };
    try {
      const wanted = await this.wanted(guide.id);
      await epg.deleteGeneration(guide.id, generation);
      const channels = new Map<string, { id: string; names: string[]; icon: string | null; kept: boolean }>();
      const keep = (id: string, names: readonly string[]) => wanted.ids.has(id.toLowerCase()) || wanted.names.has(idMatchKey(id)) || names.some((name) => wanted.names.has(matchKey(normalizeChannelName(name))));
      const buffer: OperatorProgrammeRecord[] = [];
      const stats = { programmes: 0, from: null as Date | null, to: null as Date | null };
      await this.deps.reader.read(this.deps.secrets.openGuideUrl(guide.url), lease.signal, {
        channel: (channel) => {
          if (!channels.has(channel.id) && channels.size >= MAX_GUIDE_CHANNELS) throw new GuideFetchError('too_large', `The guide declares more than ${MAX_GUIDE_CHANNELS} channels.`);
          channels.set(channel.id, { ...channel, kept: keep(channel.id, channel.names) });
        },
        programme: (programme) => {
          if (programme.stop <= window.from || programme.start >= window.to) return;
          let channel = channels.get(programme.channelId);
          if (!channel) {
            if (channels.size >= MAX_GUIDE_CHANNELS) throw new GuideFetchError('too_large', `The guide declares more than ${MAX_GUIDE_CHANNELS} channels.`);
            channel = { id: programme.channelId, names: [], icon: null, kept: keep(programme.channelId, []) };
            channels.set(programme.channelId, channel);
          }
          if (!channel.kept) return;
          buffer.push({ epgChannelId: programme.channelId, start: programme.start, stop: programme.stop, title: programme.title, subtitle: programme.subtitle, description: programme.description, categories: programme.categories, icon: programme.icon });
          stats.programmes++;
          if (!stats.from || programme.start < stats.from) stats.from = programme.start;
          if (!stats.to || programme.stop > stats.to) stats.to = programme.stop;
        },
        drain: async () => {
          lease.signal.throwIfAborted();
          if (buffer.length >= BATCH) await epg.insertProgrammes(guide.id, generation, buffer.splice(0));
        },
      });
      if (buffer.length > 0) await epg.insertProgrammes(guide.id, generation, buffer.splice(0));
      if (channels.size === 0) throw new GuideFetchError('invalid', 'The guide contains no channels.');
      // Every channel is kept in the list (for manual mapping); programmes only for usable ones.
      await epg.insertChannels(guide.id, generation, [...channels.values()].map(({ id, names, icon }) => ({ id, names, icon })));
      lease.signal.throwIfAborted();
      const committed = await epg.commitGeneration(guide.id, lease.owner, generation, { channels: channels.size, programmes: stats.programmes, from: stats.from?.toISOString() ?? null, to: stats.to?.toISOString() ?? null });
      if (!committed) {
        await epg.deleteGeneration(guide.id, generation);
        log.warn('Operator guide generation swap lost a race; discarded');
        return;
      }
      await epg.completeSync(guide.id, lease.owner, { status: 'idle', error: null, lastSuccessAt: now, nextAt: new Date(this.deps.clock.now().getTime() + guide.syncIntervalHours * HOUR), failures: 0 });
      const mapped = await this.automap();
      log.info({ generation, channels: channels.size, programmes: stats.programmes, mapped }, 'Operator guide synced');
    } catch (error) {
      await epg.deleteGeneration(guide.id, generation).catch(() => undefined);
      if (lease.signal.aborted) return;
      const failures = guide.sync.failures + 1;
      const message = error instanceof GuideFetchError ? error.message : 'The guide could not be read.';
      log.warn({ err: error }, 'Operator guide sync failed');
      await epg.completeSync(guide.id, lease.owner, { status: 'failed', error: message, nextAt: new Date(this.deps.clock.now().getTime() + Math.min(guide.syncIntervalHours * HOUR, 15 * 60_000 * 2 ** Math.min(failures - 1, 6))), failures });
    }
  }

  /** Recomputes the automatic mappings from the current guides; returns how many channels are mapped. */
  async automap(): Promise<number> {
    const [channels, aliases, guideChannels, mappings] = await Promise.all([this.deps.epg.activeChannels(), this.deps.epg.channelAliases(), this.deps.epg.currentGuideChannels(), this.deps.epg.mappings()]);
    const manual = new Set(mappings.filter((mapping) => mapping.method === 'manual').map((mapping) => mapping.channelId));
    // Best guide channel per key: lower priority number first, then guide id (stable).
    const byId = new Map<string, { guideId: string; id: string; priority: number }>();
    const byName = new Map<string, { guideId: string; id: string; priority: number }>();
    const better = (current: { priority: number; guideId: string } | undefined, candidate: { priority: number; guideId: string }) => !current || candidate.priority < current.priority || (candidate.priority === current.priority && candidate.guideId < current.guideId);
    for (const channel of guideChannels) {
      const entry = { guideId: channel.guideId, id: channel.id, priority: channel.priority };
      const idKey = channel.id.toLowerCase();
      if (better(byId.get(idKey), entry)) byId.set(idKey, entry);
      for (const key of [idMatchKey(channel.id), ...channel.names.map((name) => matchKey(normalizeChannelName(name)))]) {
        if (key && better(byName.get(key), entry)) byName.set(key, entry);
      }
    }
    const keys = new Map<string, { tvg: string[]; names: string[] }>();
    for (const channel of channels) keys.set(channel.id, { tvg: [], names: [matchKey(normalizeChannelName(channel.name))] });
    for (const alias of aliases) {
      const entry = keys.get(alias.channelId);
      if (!entry) continue;
      if (alias.kind === 'tvg_id') entry.tvg.push(alias.key.toLowerCase());
      else entry.names.push(matchKey(alias.key));
    }
    const auto: ChannelEpgRecord[] = [];
    for (const [channelId, entry] of keys) {
      if (manual.has(channelId)) continue;
      const match = entry.tvg.map((key) => byId.get(key)).find(Boolean) ?? entry.names.map((key) => (key ? byName.get(key) : undefined)).find(Boolean);
      if (match) auto.push({ channelId, guideId: match.guideId, epgChannelId: match.id, method: 'auto' });
    }
    await this.deps.epg.replaceAutoMappings(auto, this.deps.clock.now());
    return auto.length + manual.size;
  }

  /** What a guide's sync keeps programmes for: alias keys of active channels and manual mappings to it. */
  private async wanted(guideId: string): Promise<{ ids: Set<string>; names: Set<string> }> {
    const [channels, aliases, mappings] = await Promise.all([this.deps.epg.activeChannels(), this.deps.epg.channelAliases(), this.deps.epg.mappings()]);
    const ids = new Set<string>();
    const names = new Set<string>(channels.map((channel) => matchKey(normalizeChannelName(channel.name))).filter(Boolean));
    for (const alias of aliases) {
      if (alias.kind === 'tvg_id') ids.add(alias.key.toLowerCase());
      else names.add(matchKey(alias.key));
    }
    for (const mapping of mappings) if (mapping.guideId === guideId) ids.add(mapping.epgChannelId.toLowerCase());
    return { ids, names };
  }

  private async requireGuide(id: string): Promise<OperatorGuideRecord> {
    const guide = await this.deps.epg.findGuide(id);
    if (!guide) throw AppError.notFound('Guide');
    return guide;
  }

  private async checkUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw AppError.validation('Enter the full guide address (https://…).');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw AppError.validation('Guides are fetched over HTTP(S).');
    try {
      await this.deps.urlPolicy.assertAllowed(url);
    } catch {
      throw AppError.validation('This address points to a private or local network, which this server does not access.');
    }
    return url;
  }
}

export function createOperatorEpgWorker(deps: { epg: OperatorEpgRepository; service: OperatorEpgService }): Worker {
  return {
    name: OPERATOR_EPG_JOB,
    pollIntervalMs: 60_000,
    concurrency: 1,
    leaseMs: 3 * 60_000,
    claim: async (owner, now, leaseUntil) => {
      const guide = await deps.epg.claimDue(now, owner, leaseUntil);
      if (!guide) return null;
      return { label: `operator-guide:${guide.id}`, heartbeat: (leaseOwner, until) => deps.epg.heartbeat(guide.id, leaseOwner, until), run: (lease) => deps.service.run(guide, lease) };
    },
  };
}

/** Longest stretch in [from, to) not covered by any programme. */
function gapMs(programmes: readonly { start: Date; stop: Date }[], from: Date, to: Date): number {
  let cursor = from.getTime();
  let longest = 0;
  for (const programme of [...programmes].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const start = Math.max(programme.start.getTime(), from.getTime());
    if (start > cursor) longest = Math.max(longest, start - cursor);
    cursor = Math.max(cursor, Math.min(programme.stop.getTime(), to.getTime()));
  }
  return Math.max(longest, to.getTime() - cursor);
}

function toProgramme(programme: OperatorProgrammeRecord) {
  return { title: programme.title, subtitle: programme.subtitle, start: programme.start.toISOString(), stop: programme.stop.toISOString() };
}

function toGuideDto(guide: OperatorGuideRecord, mappedChannels: number): OperatorGuideDto {
  return {
    id: guide.id,
    name: guide.name,
    host: guide.host,
    status: guide.status,
    priority: guide.priority,
    syncIntervalHours: guide.syncIntervalHours,
    sync: { status: guide.sync.status, lastAttemptAt: guide.sync.lastAttemptAt?.toISOString() ?? null, lastSuccessAt: guide.sync.lastSuccessAt?.toISOString() ?? null, nextAt: guide.sync.nextAt?.toISOString() ?? null, error: guide.sync.error },
    stats: guide.stats,
    mappedChannels,
    createdAt: guide.createdAt.toISOString(),
  };
}

const guideState = (guide: OperatorGuideRecord) => ({ name: guide.name, urlHash: guide.urlHash, status: guide.status, priority: guide.priority, syncIntervalHours: guide.syncIntervalHours });
const hashUrl = (url: string) => createHash('sha256').update(url).digest('hex');

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
