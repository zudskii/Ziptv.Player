import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { useCheckoutStatus, useInvalidateCommerce } from '../../features/billing/api';
import { errorMessage } from '../../lib/api-client';
import { t } from '../../i18n';

/**
 * /billing/return?checkout=… — where the processor sends the browser back. Shows "confirming"
 * until the server has verified the payment itself; the redirect alone proves nothing.
 */
export function BillingReturnPage() {
  const [params] = useSearchParams();
  const id = params.get('checkout');
  const status = useCheckoutStatus(id);
  const invalidate = useInvalidateCommerce();
  const completed = status.data?.status === 'completed';
  useEffect(() => {
    if (completed) void invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the payment is confirmed
  }, [completed]);

  let body;
  if (!id || status.isError) {
    body = (
      <Outcome icon={<CircleX className="h-10 w-10 text-red-500" />} title={t('billing.return.notFound')} description={status.isError ? errorMessage(status.error) : t('billing.return.incomplete')}>
        <Link to="/plans">
          <Button>{t('billing.return.back')}</Button>
        </Link>
      </Outcome>
    );
  } else if (!status.data || status.data.status === 'open') {
    body = <Outcome icon={<LoaderCircle className="h-10 w-10 animate-spin text-brand" />} title={t('billing.return.confirming')} description={t('billing.return.confirmingHint')} />;
  } else if (status.data.status === 'completed') {
    const subscription = status.data.subscription;
    body = (
      <Outcome
        icon={<CircleCheck className="h-10 w-10 text-emerald-500" />}
        title={subscription?.status === 'trialing' ? t('billing.return.trialStarted') : t('billing.return.subscribed')}
        description={subscription ? t('billing.readyPackage', { name: subscription.package.name }) : t('billing.return.ready')}
      >
        <Link to="/channels">
          <Button variant="primary">{t('billing.return.watch')}</Button>
        </Link>
        <Link to="/account">
          <Button>{t('billing.return.mine')}</Button>
        </Link>
      </Outcome>
    );
  } else {
    body = (
      <Outcome icon={<CircleX className="h-10 w-10 text-fg-subtle" />} title={t('billing.return.expired')} description={t('billing.return.expiredHint')}>
        <Link to="/plans">
          <Button>{t('billing.return.back')}</Button>
        </Link>
      </Outcome>
    );
  }
  return <div className="mx-auto flex min-h-[60vh] max-w-lg items-center p-4">{body}</div>;
}

function Outcome({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="card w-full space-y-3 p-6 text-center" role="status">
      <div className="flex justify-center" aria-hidden>
        {icon}
      </div>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="text-sm text-fg-muted">{description}</p>
      {children && <div className="flex flex-wrap justify-center gap-2 pt-2">{children}</div>}
    </div>
  );
}
