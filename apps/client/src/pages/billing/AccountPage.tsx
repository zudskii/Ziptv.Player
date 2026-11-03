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

/** /account — subscription, devices and what is playing on them. */
export function AccountPage() {
  const billing = useAccountBilling();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash && billing.data) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, billing.data]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">Subscription &amp; devices</h1>
      {billing.isPending ? (
        <Spinner label="Loading your account…" />
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
        <CreditCard className="h-4 w-4 text-fg-subtle" aria-hidden /> Subscription
      </h2>
      {subscription ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold text-fg">{subscription.package.name}</span>
            {subscription.cancelAtPeriodEnd ? <Badge tone="warning">Ending</Badge> : <Badge tone={STATUS_LABEL[subscription.status].tone}>{STATUS_LABEL[subscription.status].label}</Badge>}
          </div>
          <p className="text-sm text-fg-muted">
            {subscription.cancelAtPeriodEnd
              ? `Canceled — you can watch until ${formatDate(subscription.accessUntil)}.`
              : subscription.status === 'trialing'
                ? `Free trial until ${formatDate(subscription.trialEndsAt)}, then it renews automatically.`
                : subscription.status === 'past_due' || subscription.status === 'grace'
                  ? `The last renewal failed. Access continues until ${formatDate(subscription.accessUntil)} while the payment is retried.`
                  : `Renews on ${formatDate(subscription.currentPeriodEnd)}.`}
          </p>
          <p className="text-sm text-fg-muted">
            Up to {data.limits.maxStreams} {data.limits.maxStreams === 1 ? 'stream' : 'streams'} at once on {data.limits.maxDevices} devices.
          </p>
          <div className="flex flex-wrap gap-2">
            {subscription.cancelAtPeriodEnd ? (
              <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate(undefined, { onSuccess: () => toast.success('Your subscription continues'), onError: (error) => toast.error('Not resumed', { description: errorMessage(error) }) })}>
                Resume subscription
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Cancel subscription
              </Button>
            )}
            <Link to="/plans">
              <Button>See plans</Button>
            </Link>
          </div>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title="Cancel your subscription?"
            description={`You keep watching until ${formatDate(subscription.accessUntil)}. Nothing renews after that, and you can resume before then.`}
            confirmLabel="Cancel subscription"
            onConfirm={() => cancel.mutateAsync().then(() => toast.success('Subscription canceled'))}
          />
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-muted">{comps.length > 0 ? `Your access is provided by ${comps.map((c) => c.package.name).join(', ')}.` : 'No subscription. Free channels play without one.'}</p>
          <Link to="/plans">
            <Button variant="primary">See plans</Button>
          </Link>
        </div>
      )}
    </section>
  );
}

function PlayingSection({ data }: { data: AccountBillingDto }) {
  const stop = useStopPlayback();
  const channels = useOperatorChannels();
  const name = (id: string) => channels.data?.channels.find((channel) => channel.id === id)?.name ?? 'A channel';
  if (data.playing.length === 0) return null;
  return (
    <section className="card space-y-3 p-4" aria-labelledby="playing">
      <h2 id="playing" className="flex items-center gap-2 font-semibold text-fg">
        <Tv className="h-4 w-4 text-fg-subtle" aria-hidden /> Playing now
      </h2>
      <ul className="divide-y divide-line/5">
        {data.playing.map((item) => (
          <li key={item.playbackSessionId} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{name(item.channelId)}</p>
              <p className="truncate text-xs text-fg-subtle">
                {item.deviceName} · since {new Date(item.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <Button size="sm" icon={<Square className="h-3 w-3 fill-current" />} loading={stop.isPending && stop.variables === item.playbackSessionId} onClick={() => stop.mutate(item.playbackSessionId, { onError: (error) => toast.error('Not stopped', { description: errorMessage(error) }) })}>
              Stop
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
          <MonitorSmartphone className="h-4 w-4 text-fg-subtle" aria-hidden /> Devices
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {data.devices.length} of {data.limits.maxDevices} devices. Remove one you no longer use to free its place.
        </p>
      </div>
      {data.devices.length === 0 ? (
        <p className="text-sm text-fg-subtle">A device is added when it first plays a channel.</p>
      ) : (
        <ul className="divide-y divide-line/5">
          {data.devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
                  {device.name}
                  {device.current && <Badge tone="brand">This device</Badge>}
                </p>
                <p className="truncate text-xs text-fg-subtle">Last used {formatDate(device.lastSeenAt)}</p>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setTarget(device)} aria-label={`Remove ${device.name}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`Remove ${target?.name ?? 'device'}?`}
        description="Anything playing on it stops now. It is added again (if a place is free) the next time it plays a channel."
        confirmLabel="Remove device"
        onConfirm={() => (target ? revoke.mutateAsync(target.id) : undefined)}
      />
    </section>
  );
}

function InvoicesSection({ data }: { data: AccountBillingDto }) {
  return (
    <section className="card space-y-3 p-4" aria-labelledby="invoices">
      <h2 id="invoices" className="flex items-center gap-2 font-semibold text-fg">
        <Receipt className="h-4 w-4 text-fg-subtle" aria-hidden /> Payments
      </h2>
      <ul className="divide-y divide-line/5 text-sm">
        {data.invoices.map((invoice) => (
          <li key={invoice.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 text-fg-muted">
              {formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}
            </span>
            {invoice.status === 'refunded' && <Badge tone="neutral">Refunded</Badge>}
            <span className="tabular-nums text-fg">{formatPrice(invoice.amountMinor, invoice.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
