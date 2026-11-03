import type { SystemOverviewDto } from '@ziptv/contracts';

import type { AdminQueries, OutboxRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { ConsoleQueries } from '../ports/console.js';
import type { HealthRepository } from '../ports/health.js';
import type { ChangeRequestService } from './change-requests.service.js';
import type { StaffPrincipal } from './principal.js';

/** Console overview (9.1): subscribers, viewing, catalog health, revenue (finance roles), approvals. */
export class SystemOverviewService {
  constructor(
    private readonly deps: {
      queries: AdminQueries;
      outbox: OutboxRepository;
      clock: Clock;
      console: Pick<ConsoleQueries, 'viewers' | 'activeChannels' | 'subscriptionSnapshot'>;
      health: Pick<HealthRepository, 'statusCounts' | 'openIncidentCounts'>;
      changes: Pick<ChangeRequestService, 'openCount'>;
    },
  ) {}

  async overview(actor: StaffPrincipal): Promise<SystemOverviewDto> {
    const now = this.deps.clock.now();
    const finance = actor.permissions.has('billing:read');
    const [counts, outbox, viewers, activeChannels, feeds, incidents, subscriptions, approvals] = await Promise.all([
      this.deps.queries.overview(now),
      this.deps.outbox.stats(),
      this.deps.console.viewers(now),
      this.deps.console.activeChannels(),
      this.deps.health.statusCounts(),
      this.deps.health.openIncidentCounts(),
      finance ? this.deps.console.subscriptionSnapshot() : Promise.resolve(null),
      this.deps.changes.openCount(actor),
    ]);
    return {
      ...counts,
      outbox,
      viewers,
      channels: { active: activeChannels, feeds, openIncidents: Object.values(incidents).reduce((sum, value) => sum + value, 0) },
      revenue: subscriptions
        ? { mrr: subscriptions.mrr, activeSubscriptions: subscriptions.counts.active + subscriptions.counts.pastDue + subscriptions.counts.grace, trialing: subscriptions.counts.trialing, inDunning: subscriptions.counts.pastDue + subscriptions.counts.grace }
        : null,
      approvals: { open: approvals },
      generatedAt: now.toISOString(),
    };
  }
}
