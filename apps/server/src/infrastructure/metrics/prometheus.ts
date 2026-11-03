import { timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { FailoverEventReason, IncidentKind, Metrics, TelemetrySubject } from '../../application/ports/health.js';
import type { FeedHealthState, ProbeOutcome } from '../../domain/health/feed-health.js';

/** Snapshot gauges read from the database at scrape time (shared state, same on every instance). */
export interface StateGauges {
  feeds(): Promise<Record<FeedHealthState, number>>;
  incidents(): Promise<Record<IncidentKind, number>>;
}

const GAUGE_TTL_MS = 10_000;

/**
 * Prometheus metrics of one instance: process/runtime defaults, HTTP, probes, failovers,
 * incidents, telemetry, playback plans — plus feed/incident state gauges (database-backed, cached
 * briefly so a scrape storm cannot load the database).
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly probes: Histogram<'region' | 'outcome'>;
  private readonly failovers: Counter<'reason'>;
  private readonly incidents: Counter<'kind' | 'event'>;
  private readonly telemetryEvents: Counter<'subject' | 'kind'>;
  private readonly plans: Counter<'kind' | 'result'>;
  private readonly http: Histogram<'method' | 'route' | 'status'>;

  constructor(options: { defaults: boolean; state?: StateGauges; labels?: Record<string, string> }) {
    if (options.labels) this.registry.setDefaultLabels(options.labels);
    if (options.defaults) collectDefaultMetrics({ register: this.registry, prefix: 'ziptv_' });
    const registers = [this.registry];
    this.probes = new Histogram({ name: 'ziptv_probe_duration_seconds', help: 'Feed probes by region and outcome', labelNames: ['region', 'outcome'], buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20], registers });
    this.failovers = new Counter({ name: 'ziptv_failovers_total', help: 'Active-feed switches by reason', labelNames: ['reason'], registers });
    this.incidents = new Counter({ name: 'ziptv_incident_events_total', help: 'Incidents opened/resolved', labelNames: ['kind', 'event'], registers });
    this.telemetryEvents = new Counter({ name: 'ziptv_playback_telemetry_total', help: 'Client playback reports', labelNames: ['subject', 'kind'], registers });
    this.plans = new Counter({ name: 'ziptv_playback_plans_total', help: 'Playback plans issued', labelNames: ['kind', 'result'], registers });
    this.http = new Histogram({ name: 'ziptv_http_request_duration_seconds', help: 'API requests', labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers });

    const state = options.state;
    if (state) {
      const cached = <T>(load: () => Promise<T>) => {
        let value: { at: number; data: Promise<T> } | null = null;
        return () => {
          if (!value || Date.now() - value.at > GAUGE_TTL_MS) value = { at: Date.now(), data: load().catch(() => ({}) as T) };
          return value.data;
        };
      };
      const feeds = cached(() => state.feeds());
      const incidents = cached(() => state.incidents());
      new Gauge({
        name: 'ziptv_feeds',
        help: 'Playable operator feeds by health state',
        labelNames: ['state'],
        registers,
        async collect() {
          for (const [label, count] of Object.entries(await feeds())) this.set({ state: label }, count);
        },
      });
      new Gauge({
        name: 'ziptv_incidents_open',
        help: 'Open or acknowledged incidents by kind',
        labelNames: ['kind'],
        registers,
        async collect() {
          for (const [label, count] of Object.entries(await incidents())) this.set({ kind: label }, count);
        },
      });
    }
  }

  probe(region: string, outcome: ProbeOutcome, durationMs: number): void {
    this.probes.observe({ region, outcome }, durationMs / 1000);
  }

  failover(reason: FailoverEventReason): void {
    this.failovers.inc({ reason });
  }

  incident(kind: IncidentKind, event: 'opened' | 'resolved'): void {
    this.incidents.inc({ kind, event });
  }

  telemetry(subjectType: TelemetrySubject['type'], kind: 'start' | 'error'): void {
    this.telemetryEvents.inc({ subject: subjectType, kind });
  }

  playbackPlan(kind: 'byo' | 'operator', result: 'ok' | 'error'): void {
    this.plans.inc({ kind, result });
  }

  /** Request timing labelled by route *pattern* (never the raw URL: ids would explode cardinality). */
  httpMiddleware(): RequestHandler {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
        this.http.observe({ method: req.method, route, status: String(res.statusCode) }, Number(process.hrtime.bigint() - started) / 1e9);
      });
      next();
    };
  }

  /** `GET /metrics`, only with `Authorization: Bearer <METRICS_TOKEN>` (404 without a token configured). */
  handler(token: string | null): RequestHandler {
    const expected = token ? Buffer.from(`Bearer ${token}`) : null;
    return async (req, res) => {
      const given = Buffer.from(req.headers.authorization ?? '');
      if (!expected) return void res.status(404).end();
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.status(401).setHeader('WWW-Authenticate', 'Bearer').end();
      res.setHeader('Content-Type', this.registry.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(await this.registry.metrics());
    };
  }
}
