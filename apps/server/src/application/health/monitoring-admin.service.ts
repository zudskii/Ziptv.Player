import type {
  FailoverEventDto,
  FeedHealthDto,
  FeedHealthPageDto,
  ChannelFailoverDto,
  IncidentDto,
  IncidentPageDto,
  PinFeedRequest,
  ProbeResultDto,
} from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { isPinActive } from '../../domain/health/failover.js';
import type { FeedHealthState } from '../../domain/health/feed-health.js';
import { actorOf, type AdminContext, type StaffPrincipal } from '../admin/principal.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { FailoverEventRecord, FeedHealthRecord, HealthRepository, IncidentRecord, IncidentStatus, ProbeResultRecord } from '../ports/health.js';
import type { OperatorCatalogRepository } from '../ports/operator.js';
import type { HealthEvaluator } from './health-evaluator.js';

const MAX_PIN_MS = 30 * 86_400_000;

/**
 * Console side of stream health: feed states and probe history, maintenance windows, operator
 * failover overrides (pin / release) and incidents. Every change is audited in the transaction
 * that makes it; overrides are also written to the failover journal.
 */
export class MonitoringAdminService {
  constructor(
    private readonly deps: {
      health: HealthRepository;
      catalog: Pick<OperatorCatalogRepository, 'findFeed' | 'findChannel'>;
      evaluator: Pick<HealthEvaluator, 'evaluateFeed' | 'evaluateChannelIn'>;
      uow: AdminUnitOfWork;
      clock: Clock;
      /** Probe regions this deployment expects (shown as missing when they never reported). */
      regions: string[];
      onSwitch?: (channelId: string) => void;
    },
  ) {}

  async feeds(query: { status?: FeedHealthState | undefined; channelId?: string | undefined; providerId?: string | undefined; offset: number; limit: number }): Promise<FeedHealthPageDto> {
    const page = await this.deps.health.feedHealthList(query);
    return { items: page.items.map((item) => this.toFeedDto(item)), total: page.total, regions: this.deps.regions };
  }

  async probes(feedId: string, limit: number): Promise<ProbeResultDto[]> {
    await this.requireFeed(feedId);
    return (await this.deps.health.probeHistory(feedId, limit)).map(toProbeDto);
  }

  async probeNow(actor: StaffPrincipal, feedId: string, context: AdminContext): Promise<void> {
    await this.requireFeed(feedId);
    await this.deps.uow.run(async (tx) => {
      await tx.health.requestProbe(feedId, this.deps.clock.now());
      await this.audit(tx, actor, context, 'feed.probe_requested', 'feed', feedId, null, null, {});
    });
  }

  async maintenance(actor: StaffPrincipal, feedId: string, input: { on: boolean; note?: string | undefined }, context: AdminContext): Promise<FeedHealthDto> {
    const feed = await this.requireFeed(feedId);
    await this.deps.uow.run(async (tx) => {
      const before = await tx.health.lockFeedHealth(feedId);
      await tx.health.setMaintenance(feedId, input.on, input.note?.trim() || null, this.deps.clock.now());
      // Same transaction: the flag, the resulting state (and any failover) commit together.
      await this.deps.evaluator.evaluateFeed(feedId, tx.health);
      await this.audit(tx, actor, context, input.on ? 'feed.maintenance_started' : 'feed.maintenance_ended', 'feed', feedId, { maintenance: before.maintenance }, { maintenance: input.on }, { channelId: feed.channelId, note: input.note ?? null });
    });
    const page = await this.deps.health.feedHealthList({ channelId: feed.channelId, offset: 0, limit: 100 });
    return this.toFeedDto(page.items.find((item) => item.feedId === feedId)!);
  }

  async failover(channelId: string): Promise<ChannelFailoverDto> {
    const channel = await this.deps.catalog.findChannel(channelId);
    if (!channel) throw AppError.notFound('Channel');
    const [state, feeds, events] = await Promise.all([this.deps.health.failoverOf(channelId), this.deps.health.channelFeeds(channelId), this.deps.health.failoverEvents(channelId, 50)]);
    const now = this.deps.clock.now();
    const pinned = state && isPinActive(state, now);
    return {
      channelId,
      channelName: channel.name,
      activeFeedId: state?.activeFeedId ?? null,
      mode: pinned ? 'pinned' : 'auto',
      pin: pinned && state ? { feedId: state.pinnedFeedId!, until: state.pinnedUntil?.toISOString() ?? null, by: state.pinnedBy, note: state.pinNote } : null,
      lastSwitchAt: state?.lastSwitchAt?.toISOString() ?? null,
      feeds: feeds.map((feed) => ({ id: feed.id, priority: feed.priority, health: feed.health, active: feed.id === state?.activeFeedId })),
      events: events.map(toEventDto),
    };
  }

  /** Operator override: this feed serves the channel until released (or `until`). */
  async pin(actor: StaffPrincipal, channelId: string, input: PinFeedRequest, context: AdminContext): Promise<ChannelFailoverDto> {
    const channel = await this.deps.catalog.findChannel(channelId);
    if (!channel) throw AppError.notFound('Channel');
    const target = (await this.deps.health.channelFeeds(channelId)).find((feed) => feed.id === input.feedId);
    if (!target) throw AppError.validation('That feed is not a playable feed of this channel.');
    if (target.health === 'MAINTENANCE') throw new AppError('CONFLICT', 409, 'That feed is in maintenance; end the maintenance first.');
    const now = this.deps.clock.now();
    const until = input.until ? new Date(input.until) : null;
    if (until && (until <= now || until.getTime() - now.getTime() > MAX_PIN_MS)) throw AppError.validation('A pin ends in the future, at most 30 days from now.');
    let switched = false;
    await this.deps.uow.run(async (tx) => {
      const before = await tx.health.lockFailover(channelId);
      const after = { ...before, pinnedFeedId: input.feedId, pinnedUntil: until, pinnedBy: actor.id, pinNote: input.note?.trim() || null };
      await tx.health.saveFailover(after, now);
      switched = await this.deps.evaluator.evaluateChannelIn(tx.health, channelId, now, { id: actor.id, email: actor.email }, 'pinned', channel.name);
      await this.audit(tx, actor, context, 'failover.pinned', 'channel', channelId, pinState(before), pinState(after), { feedId: input.feedId, until: until?.toISOString() ?? null, note: after.pinNote });
    });
    if (switched) this.deps.onSwitch?.(channelId);
    return this.failover(channelId);
  }

  /** Back to automatic failover. */
  async unpin(actor: StaffPrincipal, channelId: string, context: AdminContext): Promise<ChannelFailoverDto> {
    const channel = await this.deps.catalog.findChannel(channelId);
    if (!channel) throw AppError.notFound('Channel');
    const now = this.deps.clock.now();
    let switched = false;
    await this.deps.uow.run(async (tx) => {
      const before = await tx.health.lockFailover(channelId);
      if (!before.pinnedFeedId) throw new AppError('CONFLICT', 409, 'This channel is not pinned.');
      const after = { ...before, pinnedFeedId: null, pinnedUntil: null, pinnedBy: null, pinNote: null };
      await tx.health.saveFailover(after, now);
      switched = await this.deps.evaluator.evaluateChannelIn(tx.health, channelId, now, { id: actor.id, email: actor.email }, 'unpinned', channel.name);
      await this.audit(tx, actor, context, 'failover.unpinned', 'channel', channelId, pinState(before), pinState(after), { feedId: before.pinnedFeedId });
    });
    if (switched) this.deps.onSwitch?.(channelId);
    return this.failover(channelId);
  }

  async incidents(query: { status?: IncidentStatus | 'live' | undefined; offset: number; limit: number }): Promise<IncidentPageDto> {
    const page = await this.deps.health.listIncidents(query);
    return { items: page.items.map(toIncidentDto), total: page.total };
  }

  async acknowledge(actor: StaffPrincipal, id: string, context: AdminContext): Promise<IncidentDto> {
    return this.changeIncident(actor, id, context, 'incident.acknowledged', (tx, now) => tx.health.acknowledgeIncident(id, actor.id, now), 'Only an open incident can be acknowledged.');
  }

  /** Manual resolve (e.g. a false alarm); detection re-opens it if the problem is still there. */
  async resolve(actor: StaffPrincipal, id: string, context: AdminContext): Promise<IncidentDto> {
    return this.changeIncident(actor, id, context, 'incident.resolved', (tx, now) => tx.health.resolveIncidentById(id, actor.id, now), 'This incident is already resolved.');
  }

  // ---------------------------------------------------------------------------------------------

  private async changeIncident(
    actor: StaffPrincipal,
    id: string,
    context: AdminContext,
    action: string,
    change: (tx: AdminTransaction, now: Date) => Promise<IncidentRecord | null>,
    conflict: string,
  ): Promise<IncidentDto> {
    const before = await this.deps.health.findIncident(id);
    if (!before) throw AppError.notFound('Incident');
    const after = await this.deps.uow.run(async (tx) => {
      const updated = await change(tx, this.deps.clock.now());
      if (!updated) throw new AppError('CONFLICT', 409, conflict);
      await this.audit(tx, actor, context, action, 'incident', id, { status: before.status }, { status: updated.status }, { kind: updated.kind, targetId: updated.targetId });
      return updated;
    });
    return toIncidentDto(after);
  }

  private async audit(tx: AdminTransaction, actor: StaffPrincipal, context: AdminContext, action: string, targetType: string, targetId: string, before: unknown, after: unknown, details: Record<string, unknown>): Promise<void> {
    await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action, targetType, targetId, beforeHash: stateHash(before), afterHash: stateHash(after), details });
  }

  private async requireFeed(feedId: string) {
    const feed = await this.deps.catalog.findFeed(feedId);
    if (!feed) throw AppError.notFound('Feed');
    return feed;
  }

  private toFeedDto(item: FeedHealthRecord): FeedHealthDto {
    const reported = new Set(item.regions.map((region) => region.region));
    return {
      feedId: item.feedId,
      channelId: item.channelId,
      channelName: item.channelName,
      providerId: item.providerId,
      providerName: item.providerName,
      priority: item.priority,
      feedStatus: item.feedStatus,
      status: item.status,
      since: item.since.toISOString(),
      maintenance: item.maintenance,
      maintenanceNote: item.maintenanceNote,
      regions: item.regions.map((region) => ({
        region: region.region,
        state: region.state,
        failures: region.failures,
        successes: region.successes,
        lastProbeAt: region.lastProbeAt?.toISOString() ?? null,
        lastOkAt: region.lastOkAt?.toISOString() ?? null,
        lastOutcome: region.lastOutcome,
        lastError: region.lastError,
      })),
      missingRegions: this.deps.regions.filter((region) => !reported.has(region)),
    };
  }
}

const pinState = (state: { pinnedFeedId: string | null; pinnedUntil: Date | null; pinNote: string | null }) => ({ pinnedFeedId: state.pinnedFeedId, pinnedUntil: state.pinnedUntil, pinNote: state.pinNote });

function toProbeDto(result: ProbeResultRecord): ProbeResultDto {
  return {
    region: result.region,
    probedAt: result.probedAt.toISOString(),
    kind: result.kind,
    outcome: result.outcome,
    httpStatus: result.httpStatus,
    ttfbMs: result.ttfbMs,
    durationMs: result.durationMs,
    bytes: result.bytes,
    mediaSequence: result.mediaSequence,
    error: result.error,
  };
}

function toEventDto(event: FailoverEventRecord): FailoverEventDto {
  return {
    occurredAt: event.occurredAt.toISOString(),
    fromFeedId: event.fromFeedId,
    toFeedId: event.toFeedId,
    reason: event.reason,
    actorEmail: event.actorEmail,
    details: event.details,
  };
}

function toIncidentDto(incident: IncidentRecord): IncidentDto {
  return {
    id: incident.id,
    kind: incident.kind,
    severity: incident.severity,
    status: incident.status,
    targetType: incident.targetType,
    targetId: incident.targetId,
    title: incident.title,
    details: incident.details,
    openedAt: incident.openedAt.toISOString(),
    lastSeenAt: incident.lastSeenAt.toISOString(),
    acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  };
}
