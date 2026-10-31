import type { MailMessage } from '../ports/mailer.js';

type Template = Omit<MailMessage, 'to'>;

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function layout(heading: string, intro: string, link: string, buttonLabel: string, outro: string): string {
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1f26">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;color:#6b7280">ZIPTV</p>
        <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
        <p style="margin:0 0 24px"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(buttonLabel)}</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280">Or copy this address into your browser:</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:#4f46e5">${safeLink}</a></p>
        <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280">${escapeHtml(outro)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function passwordResetMail(link: string, ttlMinutes: number): Template {
  const outro = `The link works once and expires in ${ttlMinutes} minutes. If you did not ask to reset your password, ignore this email: nothing changes and your password stays as it is.`;
  return {
    subject: 'Reset your ZIPTV password',
    text: `Someone asked to reset the password of your ZIPTV account.\n\nChoose a new password here:\n${link}\n\n${outro}\n`,
    html: layout('Reset your password', 'Someone asked to reset the password of your ZIPTV account. Choose a new one with the button below.', link, 'Choose a new password', outro),
  };
}

export function verifyEmailMail(link: string, ttlHours: number): Template {
  const outro = `The link expires in ${ttlHours} hours. If you did not create a ZIPTV account, ignore this email.`;
  return {
    subject: 'Confirm your email address for ZIPTV',
    text: `Confirm that this is your email address:\n${link}\n\n${outro}\n`,
    html: layout('Confirm your email', 'Confirm that this is your email address, so we can reach you if you ever forget your password.', link, 'Confirm my email', outro),
  };
}
