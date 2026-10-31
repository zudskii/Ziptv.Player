import nodemailer, { type Transporter } from 'nodemailer';

import type { MailMessage, Mailer } from '../../application/ports/mailer.js';

/**
 * Sends through any SMTP server (`smtps://user:pass@host:465`, `smtp://user:pass@host:587`).
 * Timeouts are short: a mail server that hangs must not hold things up for minutes.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({ url: smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  }
}
