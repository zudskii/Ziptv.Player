import { sql } from 'kysely';

import type { ConsoleQueries, Money, PackageFinanceRow, StaffSecurityRow, SubscriptionCounts, SupportNoteRecord, PartnerTerms } from '../../../../application/ports/console.js';
import { isEntityId } from '../../../../domain/shared/ids.js';
import type { Db } from '../database.js';

const PLAYABLE = sql`f.status = 'active' AND p.status = 'active' AND s.status = 'matched'`;
/** Watching ends at the last heartbeat (+ one interval); a timed-out session's end is its expiry. */
const WATCH_END = sql`least(coalesce(ps.ended_at, ps.last_heartbeat_at + interval '30 seconds'), ps.last_heartbeat_at + interval '30 seconds')`;

const money = (rows: { currency: string; amount: string | number | null }[]): Money[] =>
  rows.filter((row) => row.amount !== null && Number(row.amount) !== 0).map((row) => ({ currency: row.currency, amountMinor: Math.round(Number(row.amount)) })).sort((a, b) => a.currency.localeCompare(b.currency));

/** Console read models (Phase 9). Plain SQL: aggregates over the commerce, catalog and health tables. */

/** The subscription (alias `s`) has had at least one paid invoice. */
const PAID_EVER = sql`EXISTS (SELECT 1 FROM invoices pi WHERE pi.subscription_id = s.id AND pi.paid_at IS NOT NULL)`;

export class PgConsoleQueries implements ConsoleQueries {
  constructor(private readonly db: Db) {}

  async viewers(now: Date): Promise<{ playingNow: number; started24h: number }> {
    const row = await sql<{ playing: string; started: string }>`
      SELECT
        count(*) FILTER (WHERE ended_at IS NULL AND expires_at > ${now}) AS playing,
        count(*) FILTER (WHERE started_at > ${new Date(now.getTime() - 86_400_000)}) AS started
      FROM playback_sessions
      WHERE (ended_at IS NULL AND expires_at > ${now}) OR started_at > ${new Date(now.getTime() - 86_400_000)}`.execute(this.db);
    return { playingNow: Number(row.rows[0]?.playing ?? 0), started24h: Number(row.rows[0]?.started ?? 0) };
  }

  async activeChannels(): Promise<number> {
    const row = await this.db.selectFrom('channel_master').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'active').executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async subscriptionSnapshot(): Promise<{ mrr: Money[]; counts: SubscriptionCounts }> {
    // MRR from what paying subscribers actually pay (their latest paid invoice), not the list
    // price: a price change applies to new checkouts only.
    const [mrr, counts] = await Promise.all([
      sql<{ currency: string; amount: string }>`
        SELECT i.currency, sum(CASE WHEN i.period_end - i.period_start > interval '300 days' THEN i.amount_minor / 12.0 ELSE i.amount_minor END) AS amount
        FROM subscriptions s
        JOIN LATERAL (
          SELECT currency, amount_minor, period_start, period_end FROM invoices
          WHERE subscription_id = s.id AND status = 'paid' ORDER BY period_end DESC LIMIT 1
        ) i ON true
        WHERE s.status IN ('active', 'past_due', 'grace')
        GROUP BY i.currency`.execute(this.db),
      sql<{ active: string; trialing: string; past_due: string; grace: string; ending: string }>`
        SELECT
          count(*) FILTER (WHERE status = 'active') AS active,
          count(*) FILTER (WHERE status = 'trialing') AS trialing,
          count(*) FILTER (WHERE status = 'past_due') AS past_due,
          count(*) FILTER (WHERE status = 'grace') AS grace,
          count(*) FILTER (WHERE cancel_at_period_end) AS ending
        FROM subscriptions WHERE status NOT IN ('canceled', 'expired')`.execute(this.db),
    ]);
    const c = counts.rows[0];
    return {
      mrr: money(mrr.rows),
      counts: { active: Number(c?.active ?? 0), trialing: Number(c?.trialing ?? 0), pastDue: Number(c?.past_due ?? 0), grace: Number(c?.grace ?? 0), endingAtPeriodEnd: Number(c?.ending ?? 0) },
    };
  }

  async periodFinance(from: Date, to: Date): Promise<{ newSubscriptions: number; churned: number; activeAtStart: number; revenue: Money[]; refunds: Money[] }> {
    const [subs, revenue, refunds] = await Promise.all([
      // Only subscriptions that were ever paid for: an abandoned checkout is neither a customer won nor lost.
      sql<{ started: string; churned: string; at_start: string }>`
        SELECT
          count(*) FILTER (WHERE created_at >= ${from} AND created_at < ${to}) AS started,
          count(*) FILTER (WHERE status IN ('canceled', 'expired') AND ended_at >= ${from} AND ended_at < ${to}) AS churned,
          count(*) FILTER (WHERE created_at < ${from} AND (ended_at IS NULL OR ended_at >= ${from})) AS at_start
        FROM subscriptions s
        WHERE ${PAID_EVER}`.execute(this.db),
      sql<{ currency: string; amount: string }>`SELECT currency, sum(amount_minor) AS amount FROM invoices WHERE paid_at >= ${from} AND paid_at < ${to} GROUP BY currency`.execute(this.db),
      sql<{ currency: string; amount: string }>`SELECT currency, sum(amount_minor) AS amount FROM invoices WHERE status = 'refunded' AND refunded_at >= ${from} AND refunded_at < ${to} GROUP BY currency`.execute(this.db),
    ]);
    const row = subs.rows[0];
    return { newSubscriptions: Number(row?.started ?? 0), churned: Number(row?.churned ?? 0), activeAtStart: Number(row?.at_start ?? 0), revenue: money(revenue.rows), refunds: money(refunds.rows) };
  }

  async monthlyFinance(buckets: readonly { start: Date; end: Date }[]): Promise<{ newSubscriptions: number; churned: number; revenue: Money[]; refunds: Money[] }[]> {
    if (!buckets.length) return [];
    const starts = buckets.map((bucket) => bucket.start.toISOString());
    const ends = buckets.map((bucket) => bucket.end.toISOString());
    const b = sql`(SELECT ord, s, e FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) WITH ORDINALITY AS t(s, e, ord))`;
    const first = buckets[0]!.start;
    const [subs, revenue, refunds] = await Promise.all([
      sql<{ ord: string; started: string; churned: string }>`
        SELECT b.ord,
          count(*) FILTER (WHERE s.created_at >= b.s AND s.created_at < b.e) AS started,
          count(*) FILTER (WHERE s.status IN ('canceled', 'expired') AND s.ended_at >= b.s AND s.ended_at < b.e) AS churned
        FROM ${b} b
        JOIN subscriptions s ON (s.created_at >= b.s AND s.created_at < b.e) OR (s.ended_at >= b.s AND s.ended_at < b.e)
        WHERE (s.created_at >= ${first} OR s.ended_at >= ${first}) AND ${PAID_EVER}
        GROUP BY b.ord`.execute(this.db),
      sql<{ ord: string; currency: string; amount: string }>`
        SELECT b.ord, i.currency, sum(i.amount_minor) AS amount
        FROM ${b} b JOIN invoices i ON i.paid_at >= b.s AND i.paid_at < b.e
        GROUP BY 1, 2`.execute(this.db),
      sql<{ ord: string; currency: string; amount: string }>`
        SELECT b.ord, i.currency, sum(i.amount_minor) AS amount
        FROM ${b} b JOIN invoices i ON i.status = 'refunded' AND i.refunded_at >= b.s AND i.refunded_at < b.e
        GROUP BY 1, 2`.execute(this.db),
    ]);
    return buckets.map((_, index) => {
      const ord = String(index + 1);
      const row = subs.rows.find((candidate) => String(candidate.ord) === ord);
      return {
        newSubscriptions: Number(row?.started ?? 0),
        churned: Number(row?.churned ?? 0),
        revenue: money(revenue.rows.filter((candidate) => String(candidate.ord) === ord)),
        refunds: money(refunds.rows.filter((candidate) => String(candidate.ord) === ord)),
      };
    });
  }

  async packageNet(from: Date, to: Date): Promise<{ packageId: string; currency: string; amountMinor: number }[]> {
    const rows = await sql<{ package_id: string; currency: string; amount: string }>`
      SELECT s.package_id, i.currency,
        sum(CASE WHEN i.paid_at >= ${from} AND i.paid_at < ${to} THEN i.amount_minor ELSE 0 END)
          - sum(CASE WHEN i.status = 'refunded' AND i.refunded_at >= ${from} AND i.refunded_at < ${to} THEN i.amount_minor ELSE 0 END) AS amount
      FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
      WHERE (i.paid_at >= ${from} AND i.paid_at < ${to}) OR (i.refunded_at >= ${from} AND i.refunded_at < ${to})
      GROUP BY 1, 2`.execute(this.db);
    return rows.rows.map((row) => ({ packageId: row.package_id, currency: row.currency, amountMinor: Number(row.amount) }));
  }

  async packageFinance(from: Date, to: Date): Promise<PackageFinanceRow[]> {
    const [packages, mrr, net] = await Promise.all([
      sql<{ id: string; slug: string; name: string; status: PackageFinanceRow['status']; active: string }>`
        SELECT p.id, p.slug, p.name, p.status,
          (SELECT count(*) FROM subscriptions s WHERE s.package_id = p.id AND s.status NOT IN ('canceled', 'expired')) AS active
        FROM packages p ORDER BY p.name`.execute(this.db),
      sql<{ package_id: string; currency: string; amount: string }>`
        SELECT s.package_id, i.currency, sum(CASE WHEN i.period_end - i.period_start > interval '300 days' THEN i.amount_minor / 12.0 ELSE i.amount_minor END) AS amount
        FROM subscriptions s
        JOIN LATERAL (SELECT currency, amount_minor, period_start, period_end FROM invoices WHERE subscription_id = s.id AND status = 'paid' ORDER BY period_end DESC LIMIT 1) i ON true
        WHERE s.status IN ('active', 'past_due', 'grace')
        GROUP BY 1, 2`.execute(this.db),
      this.packageNet(from, to),
    ]);
    return packages.rows.map((pkg) => ({
      id: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      status: pkg.status,
      activeSubscriptions: Number(pkg.active),
      mrr: money(mrr.rows.filter((row) => row.package_id === pkg.id)),
      net: money(net.filter((row) => row.packageId === pkg.id).map((row) => ({ currency: row.currency, amount: row.amountMinor }))),
    }));
  }

  async watchMinutes(from: Date, to: Date): Promise<{ packageId: string; providerId: string | null; minutes: number; catchupMinutes: number }[]> {
    const watched = sql`greatest(0, extract(epoch FROM (least(${WATCH_END}, ${to}::timestamptz) - greatest(ps.started_at, ${from}::timestamptz))))`;
    const rows = await sql<{ package_id: string; provider_id: string | null; minutes: string; catchup_minutes: string }>`
      SELECT ps.package_id, ps.provider_id,
        coalesce(sum(${watched}) FILTER (WHERE ps.archive_start IS NULL), 0) / 60.0 AS minutes,
        coalesce(sum(${watched}) FILTER (WHERE ps.archive_start IS NOT NULL), 0) / 60.0 AS catchup_minutes
      FROM playback_sessions ps
      WHERE ps.access = 'package' AND ps.package_id IS NOT NULL AND ps.started_at < ${to} AND ${WATCH_END} > ${from}
      GROUP BY 1, 2`.execute(this.db);
    return rows.rows.map((row) => ({ packageId: row.package_id, providerId: row.provider_id, minutes: Number(row.minutes), catchupMinutes: Number(row.catchup_minutes) })).filter((row) => row.minutes > 0 || row.catchupMinutes > 0);
  }

  async providers(): Promise<PartnerTerms[]> {
    const rows = await this.db
      .selectFrom('providers')
      .select(['id', 'name', 'contract_ref', 'monthly_cost_minor', 'cost_currency', 'minimum_guarantee_minor', 'guarantee_currency', 'catchup_weight', 'catchup_fee_per_hour_minor', 'catchup_fee_currency'])
      .orderBy('name')
      .execute();
    const money = (amount: number | null, currency: string | null): Money | null => (amount !== null && currency ? { currency, amountMinor: amount } : null);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      contractRef: row.contract_ref,
      monthlyCost: money(row.monthly_cost_minor, row.cost_currency),
      minimumGuarantee: money(row.minimum_guarantee_minor, row.guarantee_currency),
      catchupWeight: Number(row.catchup_weight),
      catchupFeePerHour: money(row.catchup_fee_per_hour_minor, row.catchup_fee_currency),
    }));
  }

  async providerReport(providerId: string, since: Date): Promise<{ feeds: { total: number; healthy: number; unhealthy: number }; probes: { ok: number; total: number }; openIncidents: number; incidents: number; minutes: number }> {
    if (!isEntityId(providerId)) return { feeds: { total: 0, healthy: 0, unhealthy: 0 }, probes: { ok: 0, total: 0 }, openIncidents: 0, incidents: 0, minutes: 0 };
    const [feeds, probes, incidents, minutes] = await Promise.all([
      sql<{ total: string; healthy: string; unhealthy: string }>`
        SELECT count(*) AS total,
          count(*) FILTER (WHERE h.status = 'HEALTHY') AS healthy,
          count(*) FILTER (WHERE h.status IN ('UNHEALTHY', 'PROVIDER_OUTAGE')) AS unhealthy
        FROM channel_feeds f LEFT JOIN feed_health h ON h.feed_id = f.id
        WHERE f.provider_id = ${providerId}`.execute(this.db),
      sql<{ ok: string; total: string }>`
        SELECT count(*) FILTER (WHERE r.outcome IN ('ok', 'degraded')) AS ok, count(*) AS total
        FROM stream_probe_results r JOIN channel_feeds f ON f.id = r.feed_id
        WHERE f.provider_id = ${providerId} AND r.probed_at >= ${since} AND r.kind <> 'decode'`.execute(this.db),
      sql<{ open: string; recent: string }>`
        SELECT count(*) FILTER (WHERE i.status <> 'resolved') AS open, count(*) FILTER (WHERE i.opened_at >= ${since}) AS recent
        FROM incidents i
        WHERE (i.target_type = 'provider' AND i.target_id = ${providerId})
           OR (i.target_type = 'feed' AND i.target_id IN (SELECT id FROM channel_feeds WHERE provider_id = ${providerId}))`.execute(this.db),
      sql<{ minutes: string | null }>`
        SELECT sum(greatest(0, extract(epoch FROM (${WATCH_END} - greatest(ps.started_at, ${since}::timestamptz))))) / 60.0 AS minutes
        FROM playback_sessions ps WHERE ps.provider_id = ${providerId} AND ${WATCH_END} > ${since}`.execute(this.db),
    ]);
    const f = feeds.rows[0];
    const p = probes.rows[0];
    const i = incidents.rows[0];
    return {
      feeds: { total: Number(f?.total ?? 0), healthy: Number(f?.healthy ?? 0), unhealthy: Number(f?.unhealthy ?? 0) },
      probes: { ok: Number(p?.ok ?? 0), total: Number(p?.total ?? 0) },
      openIncidents: Number(i?.open ?? 0),
      incidents: Number(i?.recent ?? 0),
      minutes: Math.round(Number(minutes.rows[0]?.minutes ?? 0)),
    };
  }

  async channelsForDuplicates(): Promise<{ id: string; name: string; slug: string; status: 'active' | 'hidden'; feeds: number }[]> {
    const rows = await sql<{ id: string; name: string; slug: string; status: 'active' | 'hidden'; feeds: string }>`
      SELECT c.id, c.name, c.slug, c.status, (SELECT count(*) FROM channel_feeds f WHERE f.channel_id = c.id) AS feeds
      FROM channel_master c ORDER BY c.name`.execute(this.db);
    return rows.rows.map((row) => ({ ...row, feeds: Number(row.feeds) }));
  }

  async channelStats(ids: string[]): Promise<Map<string, { feeds: number; playableFeeds: number; activeGrants: number; health: string | null }>> {
    const valid = ids.filter(isEntityId);
    const result = new Map<string, { feeds: number; playableFeeds: number; activeGrants: number; health: string | null }>();
    if (valid.length === 0) return result;
    const rows = await sql<{ id: string; feeds: string; playable: string; grants: string; health: string | null }>`
      SELECT c.id,
        (SELECT count(*) FROM channel_feeds f WHERE f.channel_id = c.id) AS feeds,
        (SELECT count(*) FROM channel_feeds f JOIN providers p ON p.id = f.provider_id JOIN provider_streams s ON s.id = f.provider_stream_id WHERE f.channel_id = c.id AND ${PLAYABLE}) AS playable,
        (SELECT count(*) FROM rights_grants g WHERE g.channel_id = c.id AND g.status = 'active' AND (g.end_at IS NULL OR g.end_at > now())) AS grants,
        coalesce(
          (SELECT h.status FROM channel_failover cf JOIN feed_health h ON h.feed_id = cf.active_feed_id WHERE cf.channel_id = c.id),
          (SELECT h.status FROM channel_feeds f LEFT JOIN feed_health h ON h.feed_id = f.id WHERE f.channel_id = c.id ORDER BY f.priority LIMIT 1)
        ) AS health
      FROM channel_master c WHERE c.id IN (${sql.join(valid)})`.execute(this.db);
    for (const row of rows.rows) result.set(row.id, { feeds: Number(row.feeds), playableFeeds: Number(row.playable), activeGrants: Number(row.grants), health: row.health ?? (Number(row.feeds) > 0 ? 'UNKNOWN' : null) });
    return result;
  }

  async countAudit(action: string, since: Date): Promise<number> {
    const row = await this.db.selectFrom('admin_audit_logs').select((eb) => eb.fn.countAll<string>().as('n')).where('action', '=', action).where('occurred_at', '>=', since).executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async staffSecurity(now: Date): Promise<StaffSecurityRow[]> {
    const rows = await sql<{ id: string; email: string; name: string; role: string; mfa: boolean; disabled: boolean; locked_until: Date | null; last_login_at: Date | null; sessions: string }>`
      SELECT u.id, u.email, u.name, u.role, u.mfa_enabled_at IS NOT NULL AS mfa, u.disabled_at IS NOT NULL AS disabled, u.locked_until, u.last_login_at,
        (SELECT count(*) FROM staff_sessions x WHERE x.staff_id = u.id AND x.idle_expires_at > ${now} AND x.absolute_expires_at > ${now}) AS sessions
      FROM staff_users u ORDER BY u.email`.execute(this.db);
    return rows.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      mfaEnabled: row.mfa,
      disabled: row.disabled,
      lockedUntil: row.locked_until && row.locked_until > now ? row.locked_until : null,
      lastLoginAt: row.last_login_at,
      activeSessions: Number(row.sessions),
    }));
  }

  async supportNotes(filter: { userId?: string | undefined; limit: number }): Promise<SupportNoteRecord[]> {
    let query = this.db
      .selectFrom('support_notes as n')
      .innerJoin('staff_users as s', 's.id', 'n.author_id')
      .innerJoin('users as u', 'u.id', 'n.user_id')
      .select(['n.id', 'n.user_id', 'u.email as user_email', 'n.body', 'n.created_at', 's.id as author_id', 's.email as author_email', 's.name as author_name'])
      .orderBy('n.created_at', 'desc')
      .limit(filter.limit);
    if (filter.userId) {
      if (!isEntityId(filter.userId)) return [];
      query = query.where('n.user_id', '=', filter.userId);
    }
    return (await query.execute()).map((row) => ({ id: row.id, userId: row.user_id, userEmail: row.user_email, author: { id: row.author_id, email: row.author_email, name: row.author_name }, body: row.body, createdAt: row.created_at }));
  }

  async addSupportNote(note: { id: string; userId: string; authorId: string; body: string; createdAt: Date }): Promise<void> {
    await this.db.insertInto('support_notes').values({ id: note.id, user_id: note.userId, author_id: note.authorId, body: note.body, created_at: note.createdAt }).execute();
  }
}
