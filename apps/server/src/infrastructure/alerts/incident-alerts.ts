import { createHmac } from 'node:crypto';

import type { OutboxHandler } from '../../application/outbox/outbox-dispatcher.js';
import { alertTopic, type AlertChannel, type IncidentRecord } from '../../application/ports/health.js';
import type { Logger } from '../../application/ports/logger.js';
import type { Mailer } from '../../application/ports/mailer.js';

const TIMEOUT_MS = 10_000;

export interface AlertConfig {
  webhookUrl: string | null;
  /** HMAC-SHA256 key: receivers verify `X-ZIPTV-Signature: sha256=<hex of body>`. */
  webhookSecret: string | null;
  slackWebhookUrl: string | null;
  emailTo: string[];
}

export function alertChannels(config: AlertConfig, mailer: Mailer | null): AlertChannel[] {
  return [...(config.webhookUrl ? ['webhook' as const] : []), ...(config.slackWebhookUrl ? ['slack' as const] : []), ...(config.emailTo.length > 0 && mailer ? ['email' as const] : [])];
}

/**
 * Outbox handlers delivering incident alerts — one topic per channel, so a failing Slack hook is
 * retried without re-sending the email. Delivery is at least once: receivers de-duplicate on
 * `X-ZIPTV-Delivery` (`<incident id>:<event>`).
 */
export function createAlertHandlers(deps: { config: AlertConfig; mailer: Mailer | null; findIncident: (id: string) => Promise<IncidentRecord | null>; consoleUrl: string | null; logger: Logger }): Record<string, OutboxHandler> {
  const load = async (payload: Record<string, unknown>) => {
    const incident = await deps.findIncident(String(payload.incidentId));
    const event = payload.event === 'resolved' ? 'resolved' : 'opened';
    return incident ? { incident, event } : null;
  };
  const summary = (incident: IncidentRecord, event: string) =>
    `${event === 'resolved' ? 'RESOLVED' : incident.severity === 'critical' ? 'CRITICAL' : 'WARNING'}: ${incident.title}`;

  const post = async (url: string, body: string, headers: Record<string, string>) => {
    const response = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Alert endpoint answered HTTP ${response.status}`);
  };

  const handlers: Partial<Record<AlertChannel, OutboxHandler>> = {
    webhook: async (payload) => {
      const loaded = await load(payload);
      if (!loaded || !deps.config.webhookUrl) return;
      const { incident, event } = loaded;
      const body = JSON.stringify({
        event,
        incident: {
          id: incident.id,
          kind: incident.kind,
          severity: incident.severity,
          status: incident.status,
          title: incident.title,
          target: { type: incident.targetType, id: incident.targetId },
          details: incident.details,
          openedAt: incident.openedAt.toISOString(),
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        },
      });
      const headers: Record<string, string> = { 'x-ziptv-delivery': `${incident.id}:${event}`, 'x-ziptv-event': `incident.${event}` };
      if (deps.config.webhookSecret) headers['x-ziptv-signature'] = `sha256=${createHmac('sha256', deps.config.webhookSecret).update(body).digest('hex')}`;
      await post(deps.config.webhookUrl, body, headers);
    },
    slack: async (payload) => {
      const loaded = await load(payload);
      if (!loaded || !deps.config.slackWebhookUrl) return;
      const icon = loaded.event === 'resolved' ? ':large_green_circle:' : loaded.incident.severity === 'critical' ? ':red_circle:' : ':large_orange_circle:';
      const link = deps.consoleUrl ? ` — <${deps.consoleUrl}/monitoring|console>` : '';
      await post(deps.config.slackWebhookUrl, JSON.stringify({ text: `${icon} ${summary(loaded.incident, loaded.event)}${link}` }), {});
    },
    email: async (payload) => {
      const loaded = await load(payload);
      if (!loaded || !deps.mailer || deps.config.emailTo.length === 0) return;
      const { incident, event } = loaded;
      const text = `${summary(incident, event)}\n\nKind: ${incident.kind}\nTarget: ${incident.targetType} ${incident.targetId}\nOpened: ${incident.openedAt.toISOString()}${incident.resolvedAt ? `\nResolved: ${incident.resolvedAt.toISOString()}` : ''}`;
      for (const to of deps.config.emailTo) {
        await deps.mailer.send({ to, subject: `[ZIPTV] ${summary(incident, event)}`, text, html: `<pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>` });
      }
    },
  };
  return Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [alertTopic(channel as AlertChannel), handler!]));
}
