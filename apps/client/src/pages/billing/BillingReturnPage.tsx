import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { useCheckoutStatus, useInvalidateCommerce } from '../../features/billing/api';
import { errorMessage } from '../../lib/api-client';

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
      <Outcome icon={<CircleX className="h-10 w-10 text-red-500" />} title="We could not find this checkout" description={status.isError ? errorMessage(status.error) : 'The link is incomplete.'}>
        <Link to="/plans">
          <Button>Back to plans</Button>
        </Link>
      </Outcome>
    );
  } else if (!status.data || status.data.status === 'open') {
    body = <Outcome icon={<LoaderCircle className="h-10 w-10 animate-spin text-brand" />} title="Confirming your payment…" description="This takes a few seconds. You can leave this page — your subscription activates as soon as the payment is confirmed." />;
  } else if (status.data.status === 'completed') {
    const subscription = status.data.subscription;
    body = (
      <Outcome
        icon={<CircleCheck className="h-10 w-10 text-emerald-500" />}
        title={subscription?.status === 'trialing' ? 'Your free trial has started' : 'You are subscribed'}
        description={subscription ? `${subscription.package.name} is ready to watch on all your devices.` : 'Your package is ready to watch.'}
      >
        <Link to="/channels">
          <Button variant="primary">Watch channels</Button>
        </Link>
        <Link to="/account">
          <Button>My subscription</Button>
        </Link>
      </Outcome>
    );
  } else {
    body = (
      <Outcome icon={<CircleX className="h-10 w-10 text-fg-subtle" />} title="This checkout has expired" description="Nothing was charged. Start again from the plans page.">
        <Link to="/plans">
          <Button>Back to plans</Button>
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
