import type { FinanceSummaryDto, MoneyDto, PartnerReportDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge, Button, DataTable, ErrorNote, PageHeader, Section, Spinner, Stat } from '../components/ui';
import { api, download } from '../lib/api';
import { dateInput, minutes, money, moneyList, percent } from '../lib/format';

type Preset = '30d' | '90d' | 'month' | 'last-month' | 'custom';

function rangeOf(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const day = 86_400_000;
  switch (preset) {
    case '30d':
      return { from: new Date(now.getTime() - 30 * day).toISOString(), to: now.toISOString() };
    case '90d':
      return { from: new Date(now.getTime() - 90 * day).toISOString(), to: now.toISOString() };
    case 'month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
    case 'last-month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() };
    case 'custom':
      return { from: custom.from ? `${custom.from}T00:00:00.000Z` : new Date(now.getTime() - 30 * day).toISOString(), to: custom.to ? `${custom.to}T23:59:59.999Z` : now.toISOString() };
  }
}

/** 9.10 — MRR, churn, revenue per package, and the licensor (partner) revenue share by watch minutes. */
export function FinancePage() {
  const [preset, setPreset] = useState<Preset>('30d');
  const [custom, setCustom] = useState(() => ({ from: dateInput(new Date(Date.now() - 30 * 86_400_000).toISOString()), to: dateInput(new Date().toISOString()) }));
  const range = useMemo(() => rangeOf(preset, custom), [preset, custom]);
  const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const summary = useQuery({ queryKey: ['finance', query], queryFn: () => api<FinanceSummaryDto>(`/finance/summary?${query}`) });
  const partners = useQuery({ queryKey: ['partners', query], queryFn: () => api<PartnerReportDto>(`/finance/partners?${query}`) });
  const data = summary.data;
  const currency = data?.mrr[0]?.currency ?? data?.period.net[0]?.currency ?? 'GEL';
  const monthValue = (values: MoneyDto[]) => values.find((value) => value.currency === currency)?.amountMinor ?? 0;
  const peak = Math.max(1, ...(data?.months.map((month) => monthValue(month.net)) ?? [1]));

  return (
    <>
      <PageHeader title="Finance" description="Money facts come from the payment processor (invoices and refunds). Amounts are per currency; nothing is converted." />
      <div className="mb-6 flex flex-wrap items-end gap-2" role="group" aria-label="Report period">
        {(
          [
            ['30d', 'Last 30 days'],
            ['90d', 'Last 90 days'],
            ['month', 'This month'],
            ['last-month', 'Last month'],
            ['custom', 'Custom'],
          ] as [Preset, string][]
        ).map(([value, label]) => (
          <Button key={value} tone={preset === value ? 'primary' : 'ghost'} onClick={() => setPreset(value)} aria-pressed={preset === value}>
            {label}
          </Button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" aria-label="From" className="field w-auto" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" aria-label="To" className="field w-auto" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
      </div>
      <ErrorNote error={summary.error} />
      {summary.isPending && <Spinner />}
      {data && (
        <>
          <Section title="Now">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="MRR" value={moneyList(data.mrr)} note="Paying subscriptions; yearly ÷ 12" />
              <Stat label="Paying" value={data.subscriptions.active + data.subscriptions.pastDue + data.subscriptions.grace} note={`${data.subscriptions.endingAtPeriodEnd} ending at period end`} />
              <Stat label="Free trials" value={data.subscriptions.trialing} />
              <Stat label="Payment problems" value={data.subscriptions.pastDue + data.subscriptions.grace} tone={data.subscriptions.pastDue + data.subscriptions.grace > 0 ? 'warn' : undefined} note={`${data.subscriptions.pastDue} past due · ${data.subscriptions.grace} in grace`} />
            </div>
          </Section>
          <Section title="Period" description={`${new Date(data.from).toLocaleDateString()} – ${new Date(data.to).toLocaleDateString()}`}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Net revenue" value={moneyList(data.period.net)} note={`paid ${moneyList(data.period.revenue)} · refunded ${moneyList(data.period.refunds)}`} />
              <Stat label="New subscriptions" value={data.period.newSubscriptions} />
              <Stat label="Churned" value={data.period.churned} note={`of ${data.period.activeAtStart} at the start`} />
              <Stat label="Churn rate" value={data.period.churnRate === null ? '—' : percent(data.period.churnRate * 100)} tone={data.period.churnRate !== null && data.period.churnRate > 0.05 ? 'warn' : undefined} />
            </div>
          </Section>
          <Section title="Last 12 months" description={`Net revenue in ${currency}`}>
            <div className="card flex h-48 items-end gap-2 p-4" role="img" aria-label="Net revenue per month">
              {data.months.map((month) => (
                <div key={month.month} className="flex flex-1 flex-col items-center gap-1" title={`${month.month}: ${moneyList(month.net)} · +${month.newSubscriptions} / −${month.churned}`}>
                  <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(2, (monthValue(month.net) / peak) * 130)}px` }} />
                  <span className="text-[10px] text-fg-subtle">{month.month.slice(5)}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Packages">
            <DataTable
              label="Package finance"
              rows={data.packages}
              rowKey={(row) => row.id}
              empty="No packages."
              columns={[
                { header: 'Package', cell: (row) => row.name },
                { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge> },
                { header: 'Live subscriptions', cell: (row) => row.activeSubscriptions, className: 'tabular-nums' },
                { header: 'MRR', cell: (row) => moneyList(row.mrr) },
                { header: 'Net in period', cell: (row) => moneyList(row.net) },
              ]}
            />
          </Section>
        </>
      )}
      <Section
        title="Partner report"
        description="Each package's net revenue split between licensors by the minutes viewers watched their feeds."
        actions={
          <Button onClick={() => download(`/finance/partners.csv?${query}`, 'ziptv-partners.csv').catch((error: Error) => toast.error(error.message))}>
            <Download className="h-4 w-4" aria-hidden /> CSV
          </Button>
        }
      >
        <ErrorNote error={partners.error} />
        {partners.data && (
          <>
            <DataTable
              label="Partners"
              rows={partners.data.partners}
              rowKey={(row) => row.providerId}
              empty="No providers."
              columns={[
                { header: 'Licensor', cell: (row) => <div><p className="font-medium">{row.providerName}</p><p className="text-xs text-fg-muted">{row.contractRef ?? '—'}</p></div> },
                { header: 'Watched', cell: (row) => minutes(row.minutes), className: 'whitespace-nowrap' },
                { header: 'Share', cell: (row) => percent(row.share * 100) },
                { header: 'Revenue share', cell: (row) => moneyList(row.revenue) },
                { header: 'Cost / month', cell: (row) => money(row.monthlyCost) },
              ]}
            />
            {partners.data.unattributedRevenue.length > 0 && <p className="mt-2 text-xs text-fg-muted">Not attributable (no viewing in the period): {moneyList(partners.data.unattributedRevenue)}</p>}
          </>
        )}
      </Section>
    </>
  );
}
