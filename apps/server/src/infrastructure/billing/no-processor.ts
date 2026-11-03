import { AppError } from '../../application/errors.js';
import { WebhookSignatureError, type PaymentProcessor, type ProcessorEvent, type ProcessorSubscription } from '../../application/ports/commerce.js';

const disabled = () => new AppError('FEATURE_DISABLED', 503, 'Purchases are not available on this server.');

/**
 * `PAYMENT_PROCESSOR=none`: no purchases. Access comes only from comp entitlements granted in the
 * console (B2B / pilots); every webhook is rejected.
 */
export class NoPaymentProcessor implements PaymentProcessor {
  readonly name = 'none';

  async createCheckout(): Promise<{ ref: string; redirectUrl: string }> {
    throw disabled();
  }

  parseWebhook(): ProcessorEvent {
    throw new WebhookSignatureError();
  }

  async fetchCheckout(): Promise<{ status: 'open' | 'paid' | 'expired'; subscription: ProcessorSubscription | null }> {
    return { status: 'expired', subscription: null };
  }

  async fetchSubscription(): Promise<ProcessorSubscription | null> {
    return null;
  }

  async cancelSubscription(): Promise<void> {
    throw disabled();
  }

  async resumeSubscription(): Promise<void> {
    throw disabled();
  }

  async refundLatestInvoice(): Promise<void> {
    throw disabled();
  }
}
