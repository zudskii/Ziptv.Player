import express, { Router } from 'express';

import type { BillingService } from '../../application/commerce/billing.service.js';
import type { HostedCheckoutPage } from '../../application/ports/commerce.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { routeParam } from '../middleware/request-context.js';

/**
 * `POST /api/v1/billing/webhooks/:processor` — the processor's server-to-server notifications.
 * Mounted before the JSON parser: the signature is computed over the exact raw bytes.
 */
export function createPaymentWebhookRouter(deps: { billing: BillingService; limit: RateLimiterFactory }): Router {
  const router = Router();
  router.post('/:processor', deps.limit({ name: 'billing:webhook', windowMs: 60_000, limit: 600 }), express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await deps.billing.handleWebhook(routeParam(req, 'processor'), body, req.headers);
    res.status(200).json({ received: true, result });
  });
  return router;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/**
 * The fake processor's hosted checkout page (development / demos only). Plain HTML forms: works
 * under the strict CSP, no scripts.
 */
export function createFakeCheckoutRouter(processor: HostedCheckoutPage): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: '4kb' }));
  router.get('/:ref', (req, res) => {
    const checkout = processor.checkout(routeParam(req, 'ref'));
    if (!checkout) return void res.status(404).send('Unknown checkout');
    const price = `${(checkout.pkg.priceMinor / 100).toFixed(2)} ${escape(checkout.pkg.currency)} / ${checkout.pkg.billingPeriod}`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Pay — checkout</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f4f7;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 24px #0002;max-width:380px;width:90%}h1{font-size:20px;margin:0 0 4px}.muted{color:#666;font-size:14px}button{width:100%;padding:12px;border:0;border-radius:8px;font-size:16px;margin-top:12px;cursor:pointer}.pay{background:#4f46e5;color:#fff}.cancel{background:#eee}.tag{display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;padding:2px 8px;border-radius:99px;margin-bottom:12px}</style></head>
<body><main><span class="tag">TEST MODE — no real money</span><h1>${escape(checkout.pkg.name)}</h1><p class="muted">${price}${checkout.trialDays > 0 ? ` · ${checkout.trialDays}-day free trial` : ''}</p>
${checkout.status === 'open' ? `<form method="post" action="${escape(checkout.ref)}/pay"><button class="pay" type="submit">${checkout.trialDays > 0 ? 'Start free trial' : 'Pay now'}</button></form><form method="post" action="${escape(checkout.ref)}/cancel"><button class="cancel" type="submit">Cancel</button></form>` : '<p>This checkout is already finished.</p>'}
</main></body></html>`);
  });
  router.post('/:ref/pay', (req, res) => {
    try {
      res.redirect(303, processor.pay(routeParam(req, 'ref')));
    } catch {
      res.status(409).send('This checkout is not open.');
    }
  });
  router.post('/:ref/cancel', (req, res) => {
    try {
      res.redirect(303, processor.abandon(routeParam(req, 'ref')));
    } catch {
      res.status(404).send('Unknown checkout');
    }
  });
  return router;
}
