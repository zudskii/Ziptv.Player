import type { SystemOverviewDto } from '@ziptv/contracts';

import type { AdminQueries, OutboxRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';

/** Console overview counters. */
export class SystemOverviewService {
  constructor(private readonly deps: { queries: AdminQueries; outbox: OutboxRepository; clock: Clock }) {}

  async overview(): Promise<SystemOverviewDto> {
    const now = this.deps.clock.now();
    const [counts, outbox] = await Promise.all([this.deps.queries.overview(now), this.deps.outbox.stats()]);
    return { ...counts, outbox, generatedAt: now.toISOString() };
  }
}
