import type { PackageOfferDto } from '@ziptv/contracts';
import { Check, CreditCard, MonitorSmartphone, Tv, UserPlus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { useAccountBilling, usePackages, useStartCheckout } from '../../features/billing/api';
import { useSessionStore } from '../../features/session/session';
import { errorMessage } from '../../lib/api-client';
import { formatPrice, STATUS_LABEL } from './format';
import { t, tx } from '../../i18n';

/** /plans — the operator's packages. Buying goes to the processor's hosted page. */
export function PlansPage() {
  const account = useSessionStore((state) => state.account);
  const packages = usePackages();
  const billing = useAccountBilling(account !== null);
  const checkout = useStartCheckout();
  const [params] = useSearchParams();
  const subscription = billing.data?.subscription ?? null;

  const buy = (offer: PackageOfferDto) =>
    checkout.mutate(offer.id, { onError: (error) => toast.error(t('billing.plans.checkoutFailed'), { description: errorMessage(error) }) });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-fg">{t('billing.plans.title')}</h1>
        <p className="text-sm text-fg-muted">{t('billing.plans.intro')}</p>
      </header>

      {params.get('canceled') && <p className="rounded-xl border border-line/10 bg-fg/5 p-3 text-sm text-fg-muted">{t('billing.plans.canceled')}</p>}
      {!account && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-fg-muted">{t('billing.plans.needAccount')}</p>
          <Link to="/register" state={{ from: '/plans' }}>
            <Button variant="primary" icon={<UserPlus className="h-4 w-4" />}>
              {t('billing.plans.createAccount')}
            </Button>
          </Link>
        </div>
      )}
      {subscription && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <Badge tone={STATUS_LABEL[subscription.status].tone}>{STATUS_LABEL[subscription.status].label}</Badge>
          <p className="min-w-0 flex-1 text-sm text-fg">
            {tx('billing.subscribedTo', { name: subscription.package.name, b: (chunks) => <span className="font-semibold">{chunks}</span> })}
          </p>
          <Link to="/account">
            <Button>{t('billing.plans.manage')}</Button>
          </Link>
        </div>
      )}

      {packages.isPending ? (
        <Spinner label={t('billing.plans.loading')} />
      ) : packages.isError ? (
        <EmptyState tone="error" title={t('billing.plans.loadFailed')} description={errorMessage(packages.error)} onRetry={() => void packages.refetch()} />
      ) : packages.data.length === 0 ? (
        <EmptyState icon={<Tv className="h-8 w-8" />} title={t('billing.plans.none')} description={t('billing.plans.noneHint')} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('billing.plans.title')}>
          {packages.data.map((offer) => {
            const current = subscription?.package.id === offer.id;
            return (
              <li key={offer.id} className="card flex flex-col gap-4 p-5" aria-label={offer.name}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-fg">{offer.name}</h2>
                    {current && <Badge tone="success">{t('billing.plans.yours')}</Badge>}
                  </div>
                  {offer.description && <p className="text-sm text-fg-muted">{offer.description}</p>}
                </div>
                <p className="text-fg">
                  <span className="text-3xl font-bold tabular-nums">{formatPrice(offer.priceMinor, offer.currency)}</span>
                  <span className="text-sm text-fg-muted"> / {t(`billing.period.${offer.billingPeriod}`)}</span>
                </p>
                <ul className="space-y-1.5 text-sm text-fg-muted">
                  <Feature icon={<Tv className="h-4 w-4" />}>{t('billing.channels', { count: offer.channels })}</Feature>
                  <Feature icon={<MonitorSmartphone className="h-4 w-4" />}>
                    {t('billing.streamsDevices', { streams: offer.maxStreams, devices: offer.maxDevices })}
                  </Feature>
                  {offer.trialDays > 0 && <Feature icon={<Check className="h-4 w-4" />}>{t('billing.trialDays', { days: offer.trialDays })}</Feature>}
                </ul>
                <div className="mt-auto">
                  <Button
                    variant="primary"
                    className="w-full justify-center"
                    icon={<CreditCard className="h-4 w-4" />}
                    disabled={!account || subscription !== null}
                    loading={checkout.isPending && checkout.variables === offer.id}
                    onClick={() => buy(offer)}
                  >
                    {offer.trialDays > 0 ? t('billing.plans.startTrial') : t('billing.plans.subscribe')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Feature({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="text-brand" aria-hidden>
        {icon}
      </span>
      {children}
    </li>
  );
}
