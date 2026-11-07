import type { DuplicateGroupDto, FinanceSummaryDto, MoneyDto, PartnerReportDto, ProviderReportDto, SecurityOverviewDto, StaffRole, SupportNoteDto } from '@ziptv/contracts';

import { newEntityId } from '../../domain/shared/ids.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import { AppError } from '../errors.js';
import type { AdminQueries, AdminUnitOfWork, AuditRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { ConsoleQueries, Money, SupportNoteRecord } from '../ports/console.js';
import { actorOf, type AdminContext, type StaffPrincipal } from './principal.js';

const DAY = 86_400_000;

/** Ended playback sessions are kept this long: the partner report cannot reach further back. */
export const PLAYBACK_SESSION_RETENTION_DAYS = 400;
const UNKNOWN_PROVIDER = 'unknown';

/**
 * Console read models and small support actions (Phase 9): finance (9.10), partner reporting,
 * provider SLA (9.3), duplicate channels (9.2), staff security (9.9), support notes (9.8).
 */
export class ConsoleService {
  constructor(
    private readonly deps: {
      queries: ConsoleQueries;
      users: Pick<AdminQueries, 'findUser'>;
      audit: Pick<AuditRepository, 'list'>;
      uow: AdminUnitOfWork;
      clock: Clock;
      /** Probe history kept (days): the window of the availability figure. */
      probeRetentionDays: number;
    },
  ) {}

  // --- finance (9.10) -------------------------------------------------------------------------------

  async finance(range: { from?: Date | undefined; to?: Date | undefined }): Promise<FinanceSummaryDto> {
    const { from, to } = this.range(range);
    const buckets = lastMonths(to, 12);
    const [snapshot, period, packages, series] = await Promise.all([
      this.deps.queries.subscriptionSnapshot(),
      this.deps.queries.periodFinance(from, to),
      this.deps.queries.packageFinance(from, to),
      this.deps.queries.monthlyFinance(buckets),
    ]);
    const months = buckets.map(({ start }, index) => {
      const month = series[index]!;
      return { month: start.toISOString().slice(0, 7), net: subtract(month.revenue, month.refunds), newSubscriptions: month.newSubscriptions, churned: month.churned };
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      mrr: snapshot.mrr,
      subscriptions: snapshot.counts,
      period: {
        newSubscriptions: period.newSubscriptions,
        churned: period.churned,
        activeAtStart: period.activeAtStart,
        churnRate: period.activeAtStart > 0 ? round(period.churned / period.activeAtStart, 4) : null,
        revenue: period.revenue,
        refunds: period.refunds,
        net: subtract(period.revenue, period.refunds),
      },
      packages,
      months,
    };
  }

  /**
   * Licensor revenue share by watch minutes: each package's net revenue in the period is split
   * between the providers whose feeds its viewers watched, in proportion to the minutes. Contract
   * terms (Phase 17.5): a catch-up minute counts by the provider's catch-up weight; a separate
   * catch-up tariff is charged per catch-up hour; a minimum guarantee (pro rata for the period)
   * tops the share up when it falls short.
   */
  async partners(range: { from?: Date | undefined; to?: Date | undefined }): Promise<PartnerReportDto> {
    const { from, to } = this.range(range);
    if (from.getTime() < this.deps.clock.now().getTime() - PLAYBACK_SESSION_RETENTION_DAYS * DAY) {
      throw AppError.validation(`Watch minutes are kept for ${PLAYBACK_SESSION_RETENTION_DAYS} days; start the partner report within that window.`);
    }
    const [net, minutes, providers] = await Promise.all([this.deps.queries.packageNet(from, to), this.deps.queries.watchMinutes(from, to), this.deps.queries.providers()]);
    const terms = new Map(providers.map((provider) => [provider.id, provider]));
    const weightOf = (providerId: string) => terms.get(providerId)?.catchupWeight ?? 1;
    const byPackage = new Map<string, Map<string, number>>(); // package → provider → weighted minutes
    const live = new Map<string, number>();
    const catchup = new Map<string, number>();
    for (const row of minutes) {
      const key = row.providerId ?? UNKNOWN_PROVIDER;
      const shares = byPackage.get(row.packageId) ?? new Map<string, number>();
      shares.set(key, (shares.get(key) ?? 0) + row.minutes + row.catchupMinutes * weightOf(key));
      byPackage.set(row.packageId, shares);
      live.set(key, (live.get(key) ?? 0) + row.minutes);
      catchup.set(key, (catchup.get(key) ?? 0) + row.catchupMinutes);
    }
    const revenue = new Map<string, Map<string, number>>(); // provider → currency → minor (unrounded)
    const unattributed = new Map<string, number>();
    for (const row of net) {
      const shares = byPackage.get(row.packageId);
      const total = shares ? [...shares.values()].reduce((sum, value) => sum + value, 0) : 0;
      if (!shares || total <= 0) {
        unattributed.set(row.currency, (unattributed.get(row.currency) ?? 0) + row.amountMinor);
        continue;
      }
      for (const [provider, watched] of shares) {
        const amounts = revenue.get(provider) ?? new Map<string, number>();
        amounts.set(row.currency, (amounts.get(row.currency) ?? 0) + (row.amountMinor * watched) / total);
        revenue.set(provider, amounts);
      }
    }
    const weighted = new Map<string, number>();
    for (const shares of byPackage.values()) for (const [provider, value] of shares) weighted.set(provider, (weighted.get(provider) ?? 0) + value);
    const totalWeighted = [...weighted.values()].reduce((sum, value) => sum + value, 0);
    const totalMinutes = [...live.values(), ...catchup.values()].reduce((sum, value) => sum + value, 0);
    // The guarantee is monthly: a period of 15 days owes half of it.
    const months = (to.getTime() - from.getTime()) / (DAY * 30.4375);
    const row = (providerId: string, provider: (typeof providers)[number] | null): PartnerReportDto['partners'][number] => {
      const amounts = revenue.get(providerId);
      const guarantee = provider?.minimumGuarantee ? { currency: provider.minimumGuarantee.currency, amountMinor: Math.round(provider.minimumGuarantee.amountMinor * months) } : null;
      const earned = guarantee ? Math.round(amounts?.get(guarantee.currency) ?? 0) : 0;
      const catchupHours = (catchup.get(providerId) ?? 0) / 60;
      return {
        providerId,
        providerName: provider?.name ?? 'Unknown provider',
        contractRef: provider?.contractRef ?? null,
        minutes: Math.round((live.get(providerId) ?? 0) + (catchup.get(providerId) ?? 0)),
        liveMinutes: Math.round(live.get(providerId) ?? 0),
        catchupMinutes: Math.round(catchup.get(providerId) ?? 0),
        share: totalWeighted > 0 ? round((weighted.get(providerId) ?? 0) / totalWeighted, 4) : 0,
        revenue: toMoney(amounts),
        monthlyCost: provider?.monthlyCost ?? null,
        minimumGuarantee: guarantee,
        guaranteeTopUp: guarantee ? { currency: guarantee.currency, amountMinor: Math.max(0, guarantee.amountMinor - earned) } : null,
        catchupFees: provider?.catchupFeePerHour ? { currency: provider.catchupFeePerHour.currency, amountMinor: Math.round(provider.catchupFeePerHour.amountMinor * catchupHours) } : null,
      };
    };
    const rows = providers.map((provider) => row(provider.id, provider));
    // Viewings recorded before the serving provider was tracked, or whose feed left the catalog.
    if (live.has(UNKNOWN_PROVIDER) || catchup.has(UNKNOWN_PROVIDER)) rows.push(row(UNKNOWN_PROVIDER, null));
    rows.sort((a, b) => b.minutes - a.minutes || a.providerName.localeCompare(b.providerName));
    return { from: from.toISOString(), to: to.toISOString(), method: 'watch_minutes', totalMinutes: Math.round(totalMinutes), partners: rows, unattributedRevenue: toMoney(unattributed) };
  }

  /** The partner report as CSV (one row per provider, one column per currency). */
  async partnersCsv(range: { from?: Date | undefined; to?: Date | undefined }): Promise<string> {
    const report = await this.partners(range);
    const currencies = [...new Set([...report.partners.flatMap((row) => row.revenue), ...report.unattributedRevenue].map((money) => money.currency))].sort();
    const header = ['provider', 'contract', 'minutes', 'live_minutes', 'catchup_minutes', 'share_pct', ...currencies.map((currency) => `revenue_${currency}`), 'monthly_cost', 'cost_currency', 'minimum_guarantee', 'guarantee_top_up', 'guarantee_currency', 'catchup_fees', 'catchup_fee_currency'];
    const amount = (money: MoneyDto | null) => (money ? minorToDecimal(money.amountMinor) : '');
    const lines = report.partners.map((row) => [
      row.providerName,
      row.contractRef ?? '',
      String(row.minutes),
      String(row.liveMinutes),
      String(row.catchupMinutes),
      (row.share * 100).toFixed(2),
      ...currencies.map((currency) => minorToDecimal(row.revenue.find((money) => money.currency === currency)?.amountMinor ?? 0)),
      amount(row.monthlyCost),
      row.monthlyCost?.currency ?? '',
      amount(row.minimumGuarantee),
      amount(row.guaranteeTopUp),
      row.minimumGuarantee?.currency ?? '',
      amount(row.catchupFees),
      row.catchupFees?.currency ?? '',
    ]);
    const unattributed = report.unattributedRevenue.length
      ? [['(unattributed: no watch minutes)', '', '0', '0', '0', '0.00', ...currencies.map((currency) => minorToDecimal(report.unattributedRevenue.find((money) => money.currency === currency)?.amountMinor ?? 0)), '', '', '', '', '', '', '']]
      : [];
    return [`# ZIPTV partner report ${report.from} – ${report.to} (method: watch minutes; catch-up weighted per contract)`, header, ...lines, ...unattributed].map((line) => (Array.isArray(line) ? line.map(csvCell).join(',') : line)).join('\r\n') + '\r\n';
  }

  // --- providers (9.3) ----------------------------------------------------------------------------

  async providerReport(providerId: string, slaTargetPct: number | null): Promise<ProviderReportDto> {
    const windowDays = Math.max(1, Math.min(30, this.deps.probeRetentionDays));
    const since = new Date(this.deps.clock.now().getTime() - windowDays * DAY);
    const report = await this.deps.queries.providerReport(providerId, since);
    const availabilityPct = report.probes.total > 0 ? round((report.probes.ok / report.probes.total) * 100, 2) : null;
    return {
      providerId,
      feeds: { total: report.feeds.total, healthy: report.feeds.healthy, unhealthy: report.feeds.unhealthy, other: Math.max(0, report.feeds.total - report.feeds.healthy - report.feeds.unhealthy) },
      windowDays,
      availabilityPct,
      slaTargetPct,
      slaMet: availabilityPct === null || slaTargetPct === null ? null : availabilityPct >= slaTargetPct,
      openIncidents: report.openIncidents,
      incidentsInWindow: report.incidents,
      watchMinutesInWindow: report.minutes,
    };
  }

  // --- channels (9.2) -----------------------------------------------------------------------------

  /** Master channels that look like the same channel (names equal once quality tags and spacing are ignored). */
  async duplicates(): Promise<DuplicateGroupDto[]> {
    const groups = new Map<string, DuplicateGroupDto['channels']>();
    for (const channel of await this.deps.queries.channelsForDuplicates()) {
      const key = normalizeChannelName(channel.name).replace(/\s+/g, '');
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), channel]);
    }
    return [...groups.entries()].filter(([, channels]) => channels.length > 1).map(([key, channels]) => ({ reason: 'name' as const, key, channels })).sort((a, b) => a.key.localeCompare(b.key));
  }

  // --- security (9.9) -----------------------------------------------------------------------------

  async security(actor: StaffPrincipal): Promise<SecurityOverviewDto> {
    const now = this.deps.clock.now();
    // The staff roster (MFA, locks, sessions) is staff data: auditors without staff:read see only the events.
    const [staff, failures, failedLogins24h] = await Promise.all([
      actor.permissions.has('staff:read') ? this.deps.queries.staffSecurity(now) : Promise.resolve([]),
      this.deps.audit.list({ action: 'staff.login_failed', limit: 20 }),
      this.deps.queries.countAudit('staff.login_failed', new Date(now.getTime() - DAY)),
    ]);
    return {
      staff: staff.map((row) => ({ ...row, role: row.role as StaffRole, lockedUntil: row.lockedUntil?.toISOString() ?? null, lastLoginAt: row.lastLoginAt?.toISOString() ?? null })),
      failedLogins24h,
      recentFailures: failures.map((entry) => ({
        seq: entry.seq,
        occurredAt: entry.occurredAt.toISOString(),
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        details: entry.details,
        ip: entry.ip,
        hash: entry.hash,
      })),
    };
  }

  // --- support notes (9.8) --------------------------------------------------------------------------

  async notes(filter: { userId?: string | undefined; limit: number }): Promise<SupportNoteDto[]> {
    return (await this.deps.queries.supportNotes(filter)).map(toNoteDto);
  }

  async addNote(actor: StaffPrincipal, userId: string, body: string, context: AdminContext): Promise<SupportNoteDto> {
    if (!(await this.deps.users.findUser(userId))) throw AppError.notFound('User');
    const text = body.trim();
    if (!text) throw AppError.validation('Write the note first.');
    const id = newEntityId();
    const now = this.deps.clock.now();
    await this.deps.uow.run(async (tx) => {
      await tx.console.addSupportNote({ id, userId, authorId: actor.id, body: text, createdAt: now });
      // The note itself stays out of the audit trail (it may hold personal details); its existence does not.
      await tx.audit.append({ ...actorOf(actor, context), occurredAt: now, action: 'support.note_added', targetType: 'user', targetId: userId, beforeHash: null, afterHash: null, details: { noteId: id, length: text.length } });
    });
    const created = (await this.deps.queries.supportNotes({ userId, limit: 50 })).find((note) => note.id === id);
    if (!created) throw new Error('Support note not found after insert');
    return toNoteDto(created);
  }

  // ---------------------------------------------------------------------------------------------

  /** Default: the last 30 days. At most two years. */
  private range(range: { from?: Date | undefined; to?: Date | undefined }): { from: Date; to: Date } {
    const to = range.to ?? this.deps.clock.now();
    const from = range.from ?? new Date(to.getTime() - 30 * DAY);
    if (from >= to) throw AppError.validation('The report must start before it ends.');
    if (to.getTime() - from.getTime() > 731 * DAY) throw AppError.validation('Reports cover at most two years.');
    return { from, to };
  }
}

function toNoteDto(note: SupportNoteRecord): SupportNoteDto {
  return { id: note.id, userId: note.userId, userEmail: note.userEmail, author: note.author, body: note.body, createdAt: note.createdAt.toISOString() };
}

/** Calendar months (UTC) ending with the month of `to`, oldest first; the last one ends at `to`. */
function lastMonths(to: Date, count: number): { start: Date; end: Date }[] {
  const months: { start: Date; end: Date }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i + 1, 1));
    months.push({ start, end: next < to ? next : to });
  }
  return months;
}

function subtract(a: readonly Money[], b: readonly Money[]): MoneyDto[] {
  const totals = new Map<string, number>();
  for (const money of a) totals.set(money.currency, (totals.get(money.currency) ?? 0) + money.amountMinor);
  for (const money of b) totals.set(money.currency, (totals.get(money.currency) ?? 0) - money.amountMinor);
  return toMoney(totals);
}

function toMoney(amounts: Map<string, number> | undefined): MoneyDto[] {
  if (!amounts) return [];
  return [...amounts.entries()]
    .map(([currency, amount]) => ({ currency, amountMinor: Math.round(amount) }))
    .filter((money) => money.amountMinor !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const minorToDecimal = (minor: number) => (minor / 100).toFixed(2);

/** RFC 4180 cell; a leading = + - @ is neutralised (spreadsheet formula injection). */
function csvCell(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
