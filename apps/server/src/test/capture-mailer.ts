import type { MailMessage, Mailer } from '../application/ports/mailer.js';

/** A mail transport for tests: keeps what was "sent", and can be made slow or broken. */
export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** While set, `send` waits for it: proves a caller did not wait for the mail server. */
  gate: Promise<void> | null = null;
  failWith: Error | null = null;

  async send(message: MailMessage): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** Mail is sent after the response, so tests wait for it to arrive. */
  async waitFor(count: number, timeoutMs = 3000): Promise<MailMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.sent.length < count) {
      if (Date.now() > deadline) throw new Error(`Expected ${count} email(s), got ${this.sent.length}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.sent;
  }

  /** For "no email was sent": gives a would-be late sender time to show up. */
  async settle(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  static linkIn(message: MailMessage): string {
    const match = /https?:\/\/\S+/.exec(message.text);
    if (!match) throw new Error('No link in the email');
    return match[0];
  }

  static tokenIn(message: MailMessage): string {
    return new URL(CapturingMailer.linkIn(message)).hash.replace(/^#token=/, '');
  }
}
