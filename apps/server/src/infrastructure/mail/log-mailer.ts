import type { Logger } from '../../application/ports/logger.js';
import type { MailMessage, Mailer } from '../../application/ports/mailer.js';

/** Development stand-in: prints the email (and the link in it) instead of sending it. Never for production. */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.info({ to: message.to, subject: message.subject }, `Email (log-only mode)\n${message.text}`);
  }
}
