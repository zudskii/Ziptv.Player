import type { FinanceSummaryDto, MoneyDto, PartnerReportDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge, Button, DataTable, ErrorNote, PageHeader, Section, Spinner, Stat } from '../components/ui';
import { api, download } from '../lib/api';
import { dateInput, formatDate, minutes, money, moneyList, percent } from '../lib/format';
import { statusLabel, t } from '../i18n';

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
      <PageHeader title={t('finance.title')} description={t('finance.intro')} />
      <div className="mb-6 flex flex-wrap items-end gap-2" role="group" aria-label={t('finance.reportPeriod')}>
        {(
          [
            ['30d', t('finance.last30')],
            ['90d', t('finance.last90')],
            ['month', t('finance.thisMonth')],
            ['last-month', t('finance.lastMonth')],
            ['custom', t('finance.custom')],
          ] as [Preset, string][]
        ).map(([value, label]) => (
          <Button key={value} tone={preset === value ? 'primary' : 'ghost'} onClick={() => setPreset(value)} aria-pressed={preset === value}>
            {label}
          </Button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" aria-label={t('finance.from')} className="field w-auto" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" aria-label={t('finance.to')} className="field w-auto" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
      </div>
      <ErrorNote error={summary.error} />
      {summary.isPending && <Spinner />}
      {data && (
        <>
          <Section title={t('finance.now')}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('finance.mrr')} value={moneyList(data.mrr)} note="Paying subscriptions; yearly ÷ 12" />
              <Stat label={t('finance.paying')} value={data.subscriptions.active + data.subscriptions.pastDue + data.subscriptions.grace} note={t('fin.endingAtEnd', { count: data.subscriptions.endingAtPeriodEnd })} />
              <Stat label={t('finance.trials')} value={data.subscriptions.trialing} />
              <Stat label={t('finance.paymentProblems')} value={data.subscriptions.pastDue + data.subscriptions.grace} tone={data.subscriptions.pastDue + data.subscriptions.grace > 0 ? 'warn' : undefined} note={t('fin.pastDueGrace', { pastDue: data.subscriptions.pastDue, grace: data.subscriptions.grace })} />
            </div>
          </Section>
          <Section title={t('common.period')} description={t('fin.range', { from: formatDate(data.from), to: formatDate(data.to) })}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('finance.net')} value={moneyList(data.period.net)} note={t('fin.paidRefunded', { paid: moneyList(data.period.revenue), refunded: moneyList(data.period.refunds) })} />
              <Stat label={t('finance.newSubs')} value={data.period.newSubscriptions} />
              <Stat label={t('finance.churned')} value={data.period.churned} note={t('fin.ofAtStart', { count: data.period.activeAtStart })} />
              <Stat label={t('finance.churnRate')} value={data.period.churnRate === null ? '—' : percent(data.period.churnRate * 100)} tone={data.period.churnRate !== null && data.period.churnRate > 0.05 ? 'warn' : undefined} />
            </div>
          </Section>
          <Section title={t('finance.last12')} description={t('fin.netIn', { currency })}>
            <div className="card flex h-48 items-end gap-2 p-4" role="img" aria-label={t('finance.netPerMonth')}>
              {data.months.map((month) => (
                <div key={month.month} className="flex flex-1 flex-col items-center gap-1" title={`${month.month}: ${moneyList(month.net)} · +${month.newSubscriptions} / −${month.churned}`}>
                  <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(2, (monthValue(month.net) / peak) * 130)}px` }} />
                  <span className="text-[10px] text-fg-subtle">{month.month.slice(5)}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title={t('finance.packages')}>
            <DataTable
              label={t('finance.packageFinance')}
              rows={data.packages}
              rowKey={(row) => row.id}
              empty={t('finance.noPackages')}
              columns={[
                { header: t('common.package'), cell: (row) => row.name },
                { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{statusLabel(row.status)}</Badge> },
                { header: t('finance.liveSubs'), cell: (row) => row.activeSubscriptions, className: 'tabular-nums' },
                { header: t('finance.mrr'), cell: (row) => moneyList(row.mrr) },
                { header: t('finance.netInPeriod'), cell: (row) => moneyList(row.net) },
              ]}
            />
          </Section>
        </>
      )}
      <Section
        title={t('finance.partnerReport')}
        description={t('finance.partnerHint')}
        actions={
          <Button onClick={() => download(`/finance/partners.csv?${query}`, 'ziptv-partners.csv').catch((error: Error) => toast.error(error.message))}>
            <Download className="h-4 w-4" aria-hidden /> {t('finance.csv')}
          </Button>
        }
      >
        <ErrorNote error={partners.error} />
        {partners.data && (
          <>
            <DataTable
              label={t('finance.partners')}
              rows={partners.data.partners}
              rowKey={(row) => row.providerId}
              empty={t('finance.noProviders')}
              columns={[
                { header: t('finance.licensor'), cell: (row) => <div><p className="font-medium">{row.providerName}</p><p className="text-xs text-fg-muted">{row.contractRef ?? '—'}</p></div> },
                {
                  header: t('finance.watched'),
                  cell: (row) => (
                    <div>
                      <p>{minutes(row.minutes)}</p>
                      {row.catchupMinutes > 0 && <p className="text-xs text-fg-muted">{t('contract.catchupPart', { minutes: minutes(row.catchupMinutes) })}</p>}
                    </div>
                  ),
                  className: 'whitespace-nowrap',
                },
                { header: t('finance.share'), cell: (row) => percent(row.share * 100) },
                { header: t('finance.revenueShare'), cell: (row) => moneyList(row.revenue) },
                {
                  header: t('contract.guarantee'),
                  cell: (row) =>
                    row.minimumGuarantee ? (
                      <div>
                        <p>{money(row.minimumGuarantee)}</p>
                        {row.guaranteeTopUp && row.guaranteeTopUp.amountMinor > 0 && <p className="text-xs text-amber-200">{t('contract.topUp', { amount: money(row.guaranteeTopUp) })}</p>}
                      </div>
                    ) : (
                      '—'
                    ),
                  className: 'whitespace-nowrap',
                },
                { header: t('contract.catchupFees'), cell: (row) => money(row.catchupFees), className: 'whitespace-nowrap' },
                { header: t('finance.costMonth'), cell: (row) => money(row.monthlyCost) },
              ]}
            />
            {partners.data.unattributedRevenue.length > 0 && <p className="mt-2 text-xs text-fg-muted">{t('fin.unattributed', { amount: moneyList(partners.data.unattributedRevenue) })}</p>}
          </>
        )}
      </Section>
    </>
  );
}
