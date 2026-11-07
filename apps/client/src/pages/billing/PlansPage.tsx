import type { CheckoutQuoteDto, PackageOfferDto, PlanChangeQuoteDto, PromoProblem } from '@ziptv/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Archive, Check, Clapperboard, CreditCard, MonitorSmartphone, Sparkles, Tag, Tv, UserPlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { billingApi, useAccountBilling, useChangePlan, usePackages, useStartCheckout } from '../../features/billing/api';
import { useSessionStore } from '../../features/session/session';
import { errorMessage } from '../../lib/api-client';
import { formatPrice, STATUS_LABEL } from './format';
import { t, tx } from '../../i18n';

const promoProblem = (problem: PromoProblem) => t(`plans.promoProblem.${problem}`);

/**
 * /plans — the operator's plans, priced for the viewer's country. Buying goes to the processor's
 * hosted page (with a promo code when one applies); a subscriber switches plans here, prorated.
 */
export function PlansPage() {
  const account = useSessionStore((state) => state.account);
  const packages = usePackages();
  const billing = useAccountBilling(account !== null);
  const checkout = useStartCheckout();
  const changePlan = useChangePlan();
  const [params] = useSearchParams();
  const subscription = billing.data?.subscription ?? null;
  const [code, setCode] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [switching, setSwitching] = useState<PackageOfferDto | null>(null);
  const offers = packages.data ?? [];
  const current = offers.find((offer) => offer.id === subscription?.package.id);
  // Switching now needs a paid (or trial) period that is not ending, and the same billing period.
  const canSwitch = (offer: PackageOfferDto) => Boolean(subscription && !subscription.cancelAtPeriodEnd && (subscription.status === 'active' || subscription.status === 'trialing') && offer.id !== subscription.package.id && (!current || current.billingPeriod === offer.billingPeriod));

  const quotes = useQueries({
    queries: offers.map((offer) => ({
      queryKey: ['billing', 'quote', offer.id, promo],
      queryFn: () => billingApi.quote({ packageId: offer.id, promoCode: promo! }),
      enabled: promo !== null && account !== null && subscription === null,
      staleTime: 60_000,
    })),
  });
  const quoteOf = (offer: PackageOfferDto): CheckoutQuoteDto | undefined => quotes[offers.indexOf(offer)]?.data;

  const buy = (offer: PackageOfferDto) => {
    const quote = quoteOf(offer);
    checkout.mutate({ packageId: offer.id, ...(promo && quote?.promo ? { promoCode: promo } : {}) }, { onError: (error) => toast.error(t('billing.plans.checkoutFailed'), { description: errorMessage(error) }) });
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPromo(code.trim() ? code.trim().toUpperCase() : null);
  };

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
            {subscription.grandfathered && <span className="block text-xs text-fg-muted">{t('plans.grandfathered')}</span>}
          </p>
          <Link to="/account">
            <Button>{t('billing.plans.manage')}</Button>
          </Link>
        </div>
      )}
      {account && !subscription && offers.length > 0 && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={apply}>
          <label className="min-w-0 flex-1 space-y-1 sm:max-w-xs">
            <span className="block text-sm text-fg-muted">{t('plans.promoCode')}</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={32} autoComplete="off" className="field uppercase" />
          </label>
          <Button type="submit" icon={<Tag className="h-4 w-4" />}>
            {t('plans.applyPromo')}
          </Button>
          {promo && (
            <Button
              variant="ghost"
              icon={<X className="h-4 w-4" />}
              onClick={() => {
                setPromo(null);
                setCode('');
              }}
            >
              {t('plans.removePromo')}
            </Button>
          )}
        </form>
      )}

      {packages.isPending ? (
        <Spinner label={t('billing.plans.loading')} />
      ) : packages.isError ? (
        <EmptyState tone="error" title={t('billing.plans.loadFailed')} description={errorMessage(packages.error)} onRetry={() => void packages.refetch()} />
      ) : offers.length === 0 ? (
        <EmptyState icon={<Tv className="h-8 w-8" />} title={t('billing.plans.none')} description={t('billing.plans.noneHint')} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('billing.plans.title')}>
          {offers.map((offer) => {
            const yours = subscription?.package.id === offer.id;
            const quote = quoteOf(offer);
            return (
              <li key={offer.id} className="card flex flex-col gap-4 p-5" aria-label={offer.name}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-fg">{offer.name}</h2>
                    {yours && <Badge tone="success">{t('billing.plans.yours')}</Badge>}
                  </div>
                  {offer.description && <p className="text-sm text-fg-muted">{offer.description}</p>}
                </div>
                <div className="text-fg">
                  <p>
                    <span className="text-3xl font-bold tabular-nums">{formatPrice(offer.priceMinor, offer.currency)}</span>
                    <span className="text-sm text-fg-muted"> / {t(`billing.period.${offer.billingPeriod}`)}</span>
                  </p>
                  {quote?.promo && (
                    <p className="mt-1 text-sm text-emerald-500">
                      {t('plans.firstPayment', { price: formatPrice(quote.promo.firstPaymentMinor, quote.currency), code: quote.promo.code })}
                    </p>
                  )}
                  {quote?.promoProblem && <p className="mt-1 text-xs text-fg-muted">{promoProblem(quote.promoProblem)}</p>}
                </div>
                <ul className="space-y-1.5 text-sm text-fg-muted">
                  <Feature icon={<Tv className="h-4 w-4" />}>{t('billing.channels', { count: offer.channels })}</Feature>
                  {offer.vodMode !== 'none' && <Feature icon={<Clapperboard className="h-4 w-4" />}>{t(`plans.vod.${offer.vodMode}`)}</Feature>}
                  {offer.maxQuality && <Feature icon={<Sparkles className="h-4 w-4" />}>{t('plans.upTo', { quality: t(`plans.quality.${offer.maxQuality}`) })}</Feature>}
                  {offer.catchupDays !== null && <Feature icon={<Archive className="h-4 w-4" />}>{offer.catchupDays === 0 ? t('plans.liveOnly') : t('plans.catchupDays', { days: offer.catchupDays })}</Feature>}
                  <Feature icon={<MonitorSmartphone className="h-4 w-4" />}>{t('billing.streamsDevices', { streams: offer.maxStreams, devices: offer.maxDevices })}</Feature>
                  {offer.trialDays > 0 && <Feature icon={<Check className="h-4 w-4" />}>{t('billing.trialDays', { days: offer.trialDays })}</Feature>}
                </ul>
                <div className="mt-auto">
                  {subscription && canSwitch(offer) ? (
                    <Button className="w-full justify-center" icon={<ArrowRightLeft className="h-4 w-4" />} onClick={() => setSwitching(offer)}>
                      {t('plans.switch')}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      className="w-full justify-center"
                      icon={<CreditCard className="h-4 w-4" />}
                      disabled={!account || subscription !== null}
                      loading={checkout.isPending && checkout.variables.packageId === offer.id}
                      onClick={() => buy(offer)}
                    >
                      {offer.trialDays > 0 ? t('billing.plans.startTrial') : t('billing.plans.subscribe')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {switching && <SwitchPlanDialog offer={switching} onClose={() => setSwitching(null)} onConfirm={() => changePlan.mutateAsync(switching.id).then((after) => toast.success(t('plans.switched', { name: after.package.name })))} />}
    </div>
  );
}

/** Shows what switching now costs (prorated) before doing it. */
function SwitchPlanDialog({ offer, onClose, onConfirm }: { offer: PackageOfferDto; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  const quoted = useQuery({ queryKey: ['billing', 'change-quote', offer.id], queryFn: () => billingApi.changeQuote(offer.id), staleTime: 0, retry: false });
  const quote: PlanChangeQuoteDto | undefined = quoted.data;
  const error = quoted.isError ? errorMessage(quoted.error) : null;
  const price = (minor: number) => formatPrice(minor, quote?.to.currency ?? offer.currency);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      tone="primary"
      title={t('plans.switchTo', { name: offer.name })}
      confirmLabel={t('plans.confirmSwitch')}
      onConfirm={onConfirm}
      description={
        error ? (
          <span role="alert">{error}</span>
        ) : !quote ? (
          <Spinner label={t('plans.quoting')} />
        ) : (
          <span className="space-y-2">
            <span className="block">{t('plans.switchSummary', { from: quote.from.name, to: quote.to.name, price: price(quote.to.priceMinor), period: t(`billing.period.${offer.billingPeriod}`) })}</span>
            <span className="block font-medium text-fg">
              {quote.dueNowMinor > 0 ? t('plans.dueNow', { amount: price(quote.dueNowMinor) }) : quote.carryMinor > 0 ? t('plans.creditKept', { amount: price(quote.carryMinor) }) : t('plans.nothingNow')}
            </span>
            {quote.remaining > 0 && <span className="block text-xs">{t('plans.prorationHint', { credit: price(quote.creditMinor), charge: price(quote.chargeMinor) })}</span>}
          </span>
        )
      }
    />
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
