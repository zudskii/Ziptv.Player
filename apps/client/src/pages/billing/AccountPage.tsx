import type { AccountBillingDto, DeviceDto } from '@ziptv/contracts';
import { CreditCard, MonitorSmartphone, Receipt, Square, Trash2, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Spinner } from '../../components/ui/Spinner';
import { useAccountBilling, useCancelSubscription, useResumeSubscription, useRevokePlaybackDevice, useStopPlayback } from '../../features/billing/api';
import { useOperatorChannels } from '../../features/operator/api';
import { errorMessage } from '../../lib/api-client';
import { formatDate, formatPrice, STATUS_LABEL } from './format';
import { i18n, t } from '../../i18n';

/** /account — subscription, devices and what is playing on them. */
export function AccountPage() {
  const billing = useAccountBilling();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash && billing.data) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, billing.data]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">{t('billing.account.title')}</h1>
      {billing.isPending ? (
        <Spinner label={t('billing.account.loading')} />
      ) : billing.isError ? (
        <p className="text-sm text-red-500">{errorMessage(billing.error)}</p>
      ) : (
        <>
          <SubscriptionSection data={billing.data} />
          <PlayingSection data={billing.data} />
          <DevicesSection data={billing.data} />
          {billing.data.invoices.length > 0 && <InvoicesSection data={billing.data} />}
        </>
      )}
    </div>
  );
}

function SubscriptionSection({ data }: { data: AccountBillingDto }) {
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();
  const [confirm, setConfirm] = useState(false);
  const subscription = data.subscription;
  const comps = data.entitlements.filter((entitlement) => entitlement.kind === 'comp' && entitlement.active);

  return (
    <section className="card space-y-3 p-4" aria-labelledby="subscription">
      <h2 id="subscription" className="flex items-center gap-2 font-semibold text-fg">
        <CreditCard className="h-4 w-4 text-fg-subtle" aria-hidden /> {t('billing.account.subscription')}
      </h2>
      {subscription ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold text-fg">{subscription.package.name}</span>
            {subscription.cancelAtPeriodEnd ? <Badge tone="warning">{t('billing.account.ending')}</Badge> : <Badge tone={STATUS_LABEL[subscription.status].tone}>{STATUS_LABEL[subscription.status].label}</Badge>}
          </div>
          <p className="text-sm text-fg-muted">
            {subscription.cancelAtPeriodEnd
              ? t('billing.canceledUntil', { date: formatDate(subscription.accessUntil) })
              : subscription.status === 'trialing'
                ? t('billing.trialUntil', { date: formatDate(subscription.trialEndsAt) })
                : subscription.status === 'past_due' || subscription.status === 'grace'
                  ? t('billing.renewalFailed', { date: formatDate(subscription.accessUntil) })
                  : t('billing.renewsOn', { date: formatDate(subscription.currentPeriodEnd) })}
          </p>
          <p className="text-sm text-fg-muted">
            {t('billing.limits', { streams: data.limits.maxStreams, devices: data.limits.maxDevices })}
          </p>
          {subscription.price && <p className="text-sm text-fg-muted">{t('plans.youPay', { price: formatPrice(subscription.price.amountMinor, subscription.price.currency) })}</p>}
          {subscription.grandfathered && <p className="rounded-lg border border-line/10 bg-fg/5 p-2 text-sm text-fg-muted">{t('plans.grandfathered')}</p>}
          <div className="flex flex-wrap gap-2">
            {subscription.cancelAtPeriodEnd ? (
              <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate(undefined, { onSuccess: () => toast.success(t('billing.account.resumed')), onError: (error) => toast.error(t('billing.account.notResumed'), { description: errorMessage(error) }) })}>
                {t('billing.account.resume')}
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setConfirm(true)}>
                {t('billing.account.cancel')}
              </Button>
            )}
            <Link to="/plans">
              <Button>{t('billing.seePlans')}</Button>
            </Link>
          </div>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title={t('billing.account.cancelTitle')}
            description={t('billing.cancelHint', { date: formatDate(subscription.accessUntil) })}
            confirmLabel={t('billing.account.cancel')}
            onConfirm={() => cancel.mutateAsync().then(() => toast.success(t('billing.account.canceled')))}
          />
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-muted">{comps.length > 0 ? t('billing.compsBy', { names: i18n.formatList(comps.map((c) => c.package.name)) }) : t('billing.account.none')}</p>
          <Link to="/plans">
            <Button variant="primary">{t('billing.seePlans')}</Button>
          </Link>
        </div>
      )}
    </section>
  );
}

function PlayingSection({ data }: { data: AccountBillingDto }) {
  const stop = useStopPlayback();
  const channels = useOperatorChannels();
  const name = (id: string) => channels.data?.channels.find((channel) => channel.id === id)?.name ?? t('billing.account.aChannel');
  if (data.playing.length === 0) return null;
  return (
    <section className="card space-y-3 p-4" aria-labelledby="playing">
      <h2 id="playing" className="flex items-center gap-2 font-semibold text-fg">
        <Tv className="h-4 w-4 text-fg-subtle" aria-hidden /> {t('billing.account.playing')}
      </h2>
      <ul className="divide-y divide-line/5">
        {data.playing.map((item) => (
          <li key={item.playbackSessionId} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{name(item.channelId)}</p>
              <p className="truncate text-xs text-fg-subtle">
                {t('billing.since', { device: item.deviceName, time: new Date(item.startedAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' }) })}
              </p>
            </div>
            <Button size="sm" icon={<Square className="h-3 w-3 fill-current" />} loading={stop.isPending && stop.variables === item.playbackSessionId} onClick={() => stop.mutate(item.playbackSessionId, { onError: (error) => toast.error(t('billing.account.notStopped'), { description: errorMessage(error) }) })}>
              {t('billing.account.stop')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DevicesSection({ data }: { data: AccountBillingDto }) {
  const revoke = useRevokePlaybackDevice();
  const [target, setTarget] = useState<DeviceDto | null>(null);
  return (
    <section className="card space-y-3 p-4" aria-labelledby="devices">
      <div>
        <h2 id="devices" className="flex items-center gap-2 font-semibold text-fg">
          <MonitorSmartphone className="h-4 w-4 text-fg-subtle" aria-hidden /> {t('billing.account.devices')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {t('billing.devicesUsed', { used: data.devices.length, max: data.limits.maxDevices })}
        </p>
      </div>
      {data.devices.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('billing.account.devicesHint')}</p>
      ) : (
        <ul className="divide-y divide-line/5">
          {data.devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
                  {device.name}
                  {device.current && <Badge tone="brand">{t('billing.account.thisDevice')}</Badge>}
                </p>
                <p className="truncate text-xs text-fg-subtle">{t('billing.lastUsed', { date: formatDate(device.lastSeenAt) })}</p>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setTarget(device)} aria-label={`Remove ${device.name}`}>
                {t('billing.account.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={t('billing.removeDeviceTitle', { name: target?.name ?? t('billing.device') })}
        description={t('billing.account.removeHint')}
        confirmLabel={t('billing.account.removeDevice')}
        onConfirm={() => (target ? revoke.mutateAsync(target.id) : undefined)}
      />
    </section>
  );
}

function InvoicesSection({ data }: { data: AccountBillingDto }) {
  return (
    <section className="card space-y-3 p-4" aria-labelledby="invoices">
      <h2 id="invoices" className="flex items-center gap-2 font-semibold text-fg">
        <Receipt className="h-4 w-4 text-fg-subtle" aria-hidden /> {t('billing.account.payments')}
      </h2>
      <ul className="divide-y divide-line/5 text-sm">
        {data.invoices.map((invoice) => (
          <li key={invoice.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 text-fg-muted">
              {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
            </span>
            {invoice.status === 'refunded' && <Badge tone="neutral">{t('billing.account.refunded')}</Badge>}
            <span className="tabular-nums text-fg">{formatPrice(invoice.amountMinor, invoice.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
