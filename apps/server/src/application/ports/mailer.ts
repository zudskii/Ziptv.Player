export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one email. Throws when the message could not be handed to the mail server. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
