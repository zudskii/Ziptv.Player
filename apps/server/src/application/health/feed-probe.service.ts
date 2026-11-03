import { DEFAULT_HEALTH_POLICY, isSuccess, nextRegionHealth, type HealthPolicy, type ProbeOutcome } from '../../domain/health/feed-health.js';
import { liveProgress } from '../../domain/health/hls-manifest.js';
import type { TaskLease, Worker } from '../jobs/job-runner.js';
import type { Clock } from '../ports/clock.js';
import type { FeedProber, HealthRepository, Metrics, ProbeResultRecord, ProbeTarget } from '../ports/health.js';
import type { Logger } from '../ports/logger.js';
import type { FeedLocators } from '../operator/feed-locators.js';
import type { HealthEvaluator } from './health-evaluator.js';

export const FEED_PROBE_JOB = 'feed-probe';
const MAX_PROBE_MS = 90_000;

export interface ProbeSchedule {
  /** This instance's probe location (e.g. `eu-central`). */
  region: string;
  intervalMs: number;
  /** Faster re-probing while a feed is failing or recovering (decisions need consecutive probes). */
  failingIntervalMs: number;
  /** How often a feed gets a decode check (0 = never). */
  decodeEveryMs: number;
  policy?: HealthPolicy;
}

/** ±10 % so feeds probed together drift apart instead of hitting providers in waves. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * One probe of one feed from this region: locate the upstream (server-side) → probe → judge
 * liveness → region state machine → store → re-evaluate the feed (and its channel's failover).
 */
export class FeedProbeService {
  constructor(
    private readonly deps: {
      health: HealthRepository;
      locators: Pick<FeedLocators, 'locate'>;
      catalog: { findFeed(id: string): Promise<{ providerId: string; providerStreamId: string } | null> };
      prober: FeedProber;
      evaluator: Pick<HealthEvaluator, 'evaluateFeed'>;
      clock: Clock;
      metrics: Metrics;
      logger: Logger;
      schedule: ProbeSchedule;
    },
  ) {}

  async run(target: ProbeTarget, lease: TaskLease): Promise<void> {
    const started = this.deps.clock.now();
    try {
      await this.probe(target, lease, started);
    } catch (error) {
      // Whatever went wrong, the probe must finish (or its lease would hold the provider's probe
      // slot until it expires). Counted as a failure; the error says why.
      this.deps.logger.warn({ err: error, feedId: target.feedId }, 'Probe failed unexpectedly');
      await this.finish(target, lease.owner, started, 'unreachable', error instanceof Error ? error.message : String(error), null, false, [], false).catch((finishError: unknown) =>
        this.deps.logger.error({ err: finishError, feedId: target.feedId }, 'Probe could not be recorded'),
      );
    }
  }

  private async probe(target: ProbeTarget, lease: TaskLease, started: Date): Promise<void> {
    const { schedule, clock } = this.deps;
    const feed = await this.deps.catalog.findFeed(target.feedId);
    if (!feed) return;

    let located;
    try {
      located = await this.deps.locators.locate(feed);
    } catch (error) {
      // The provider connection itself is unusable (credential missing/invalid): not a stream fault
      // we can observe, but the feed cannot play either.
      located = null;
      this.deps.logger.warn({ err: error, feedId: target.feedId }, 'Feed could not be located for probing');
    }
    if (!located) {
      await this.finish(target, lease.owner, started, 'not_entitled', 'Provider connection unusable', null, false, [], false);
      return;
    }

    const decode = schedule.decodeEveryMs > 0 && (!target.lastDecodeAt || started.getTime() - target.lastDecodeAt.getTime() >= schedule.decodeEveryMs);
    // A hard cap on one probe (its steps have their own timeouts; this bounds the sum).
    const observation = await this.deps.prober.probe(located.locator, located.kind, { decode, signal: AbortSignal.any([lease.signal, AbortSignal.timeout(MAX_PROBE_MS)]) });
    if (lease.signal.aborted) return;
    const probedAt = clock.now();

    let outcome: ProbeOutcome = observation.outcome;
    let keepSequenceAt = false;
    let error = observation.steps.find((step) => step.error)?.error ?? null;
    if (observation.playlist && isSuccess(outcome)) {
      const progress = liveProgress(target.previous, { ...observation.playlist, at: probedAt });
      if (progress === 'stalled') {
        outcome = 'stalled';
        error = `Live playlist has not moved since ${target.previous?.at.toISOString()} (media sequence ${observation.playlist.mediaSequence})`;
      }
      // Not moved yet but within the allowance: keep measuring from the previous change.
      keepSequenceAt = progress !== 'first' && target.previous !== null && observation.playlist.mediaSequence === target.previous.mediaSequence && observation.playlist.lastSegment === target.previous.lastSegment;
    }

    const results: ProbeResultRecord[] = observation.steps.map((step) => ({
      ...step,
      feedId: target.feedId,
      region: target.region,
      probedAt,
      mediaSequence: step.kind === 'manifest' ? (observation.playlist?.mediaSequence ?? null) : null,
    }));
    if (outcome === 'stalled') results.push({ kind: 'manifest', outcome, httpStatus: null, ttfbMs: null, durationMs: 0, bytes: null, error, feedId: target.feedId, region: target.region, probedAt, mediaSequence: observation.playlist?.mediaSequence ?? null });

    await this.finish(target, lease.owner, started, outcome, error, observation.playlist, keepSequenceAt, results, observation.decoded);
  }

  private async finish(
    target: ProbeTarget,
    owner: string,
    started: Date,
    outcome: ProbeOutcome,
    error: string | null,
    playlist: { mediaSequence: number; lastSegment: string | null } | null,
    keepSequenceAt: boolean,
    results: ProbeResultRecord[],
    decoded: boolean,
  ): Promise<void> {
    const { schedule, clock } = this.deps;
    const now = clock.now();
    const health = nextRegionHealth(target.health, outcome, schedule.policy ?? DEFAULT_HEALTH_POLICY);
    const unsettled = health.failures > 0 || (health.state !== 'HEALTHY' && health.state !== 'UNKNOWN');
    const nextProbeAt = new Date(now.getTime() + jitter(unsettled ? schedule.failingIntervalMs : schedule.intervalMs));
    const stored = await this.deps.health.completeProbe({ feedId: target.feedId, region: target.region }, owner, { health, outcome, error, probedAt: now, ok: isSuccess(outcome), nextProbeAt, playlist, keepSequenceAt, decoded }, results);
    this.deps.metrics.probe(target.region, outcome, now.getTime() - started.getTime());
    if (!stored) return; // lease lost: another instance owns this probe now
    // Re-evaluate on any change — and whenever the stored overall state is not plainly healthy,
    // so an evaluation that failed once (deadlock, timeout) heals on the next probe.
    const overall = (await this.deps.health.feedHealthOf([target.feedId])).get(target.feedId) ?? 'UNKNOWN';
    if (health.state !== target.health.state || !isSuccess(outcome) || overall !== 'HEALTHY') await this.deps.evaluator.evaluateFeed(target.feedId);
  }
}

/**
 * The probe fleet: every instance with probing enabled runs this worker for its region. Rows for
 * new feeds are created lazily; at most `providerLimit` probes per provider run at once across the
 * fleet (IPTV accounts limit concurrent connections).
 */
export function createFeedProbeWorker(deps: { health: HealthRepository; probes: FeedProbeService; clock: Clock; region: string; concurrency: number; providerLimit: number; logger: Logger }): Worker {
  let ensuredAt = 0;
  return {
    name: FEED_PROBE_JOB,
    pollIntervalMs: 5_000,
    concurrency: deps.concurrency,
    leaseMs: 60_000,
    claim: async (owner, now, leaseUntil) => {
      if (now.getTime() - ensuredAt > 15_000) {
        ensuredAt = now.getTime();
        const added = await deps.health.ensureProbeRows(deps.region, now);
        if (added > 0) deps.logger.info({ region: deps.region, added }, 'Feeds added to the probe schedule');
      }
      const target = await deps.health.claimDueProbe(deps.region, now, owner, leaseUntil, deps.providerLimit);
      if (!target) return null;
      return {
        label: `probe:${target.feedId}@${target.region}`,
        heartbeat: (leaseOwner, until) => deps.health.heartbeatProbe(target.feedId, target.region, leaseOwner, until),
        run: (lease) => deps.probes.run(target, lease),
      };
    },
  };
}
