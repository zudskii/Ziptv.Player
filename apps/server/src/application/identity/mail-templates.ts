import type { MailMessage } from '../ports/mailer.js';

type Template = Omit<MailMessage, 'to'>;

/** Languages emails are written in: the language of the screen the request came from. */
export type MailLocale = 'ka' | 'en' | 'ru';
const MAIL_LOCALES: readonly MailLocale[] = ['ka', 'en', 'ru'];

/**
 * The email language from a request's Accept-Language header (the web client sends its current UI
 * language first). Unknown or missing → English.
 */
export function mailLocale(acceptLanguage: string | null | undefined): MailLocale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const primary = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (primary && (MAIL_LOCALES as readonly string[]).includes(primary)) return primary as MailLocale;
  }
  return 'en';
}

interface MailCopy {
  orCopy: string;
  reset: { subject: string; heading: string; intro: string; textIntro: string; button: string; outro: (minutes: number) => string };
  verify: { subject: string; heading: string; intro: string; textIntro: string; button: string; outro: (hours: number) => string };
}

const COPY: Record<MailLocale, MailCopy> = {
  en: {
    orCopy: 'Or copy this address into your browser:',
    reset: {
      subject: 'Reset your ZIPTV password',
      heading: 'Reset your password',
      intro: 'Someone asked to reset the password of your ZIPTV account. Choose a new one with the button below.',
      textIntro: 'Someone asked to reset the password of your ZIPTV account.\n\nChoose a new password here:',
      button: 'Choose a new password',
      outro: (minutes) => `The link works once and expires in ${minutes} minutes. If you did not ask to reset your password, ignore this email: nothing changes and your password stays as it is.`,
    },
    verify: {
      subject: 'Confirm your email address for ZIPTV',
      heading: 'Confirm your email',
      intro: 'Confirm that this is your email address, so we can reach you if you ever forget your password.',
      textIntro: 'Confirm that this is your email address:',
      button: 'Confirm my email',
      outro: (hours) => `The link expires in ${hours} hours. If you did not create a ZIPTV account, ignore this email.`,
    },
  },
  ka: {
    orCopy: 'ან დააკოპირეთ ეს მისამართი ბრაუზერში:',
    reset: {
      subject: 'ZIPTV-ის პაროლის აღდგენა',
      heading: 'პაროლის აღდგენა',
      intro: 'ვიღაცამ ითხოვა თქვენი ZIPTV ანგარიშის პაროლის აღდგენა. აირჩიეთ ახალი პაროლი ქვემოთ მოცემული ღილაკით.',
      textIntro: 'ვიღაცამ ითხოვა თქვენი ZIPTV ანგარიშის პაროლის აღდგენა.\n\nაირჩიეთ ახალი პაროლი აქ:',
      button: 'ახალი პაროლის არჩევა',
      outro: (minutes) => `ბმული ერთხელ მუშაობს და ${minutes} წუთში იწურება. თუ პაროლის აღდგენა არ გითხოვიათ, უგულებელყავით ეს წერილი: არაფერი შეიცვლება და პაროლი იგივე დარჩება.`,
    },
    verify: {
      subject: 'დაადასტურეთ ელფოსტა ZIPTV-სთვის',
      heading: 'ელფოსტის დადასტურება',
      intro: 'დაადასტურეთ, რომ ეს თქვენი ელფოსტაა, რომ პაროლის დავიწყების შემთხვევაში დაგიკავშირდეთ.',
      textIntro: 'დაადასტურეთ, რომ ეს თქვენი ელფოსტაა:',
      button: 'ელფოსტის დადასტურება',
      outro: (hours) => `ბმული ${hours} საათში იწურება. თუ ZIPTV ანგარიში არ შეგიქმნიათ, უგულებელყავით ეს წერილი.`,
    },
  },
  ru: {
    orCopy: 'Или скопируйте этот адрес в браузер:',
    reset: {
      subject: 'Сброс пароля ZIPTV',
      heading: 'Сброс пароля',
      intro: 'Кто-то запросил сброс пароля вашего аккаунта ZIPTV. Выберите новый пароль с помощью кнопки ниже.',
      textIntro: 'Кто-то запросил сброс пароля вашего аккаунта ZIPTV.\n\nВыберите новый пароль здесь:',
      button: 'Выбрать новый пароль',
      outro: (minutes) => `Ссылка работает один раз и действует ${minutes} мин. Если вы не запрашивали сброс, просто проигнорируйте это письмо: пароль останется прежним.`,
    },
    verify: {
      subject: 'Подтвердите адрес почты для ZIPTV',
      heading: 'Подтверждение почты',
      intro: 'Подтвердите, что это ваш адрес, чтобы мы могли связаться с вами, если вы забудете пароль.',
      textIntro: 'Подтвердите, что это ваш адрес почты:',
      button: 'Подтвердить почту',
      outro: (hours) => `Ссылка действует ${hours} ч. Если вы не создавали аккаунт ZIPTV, просто проигнорируйте это письмо.`,
    },
  },
};

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function layout(locale: MailLocale, heading: string, intro: string, link: string, buttonLabel: string, outro: string): string {
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1f26">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;color:#6b7280">ZIPTV</p>
        <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
        <p style="margin:0 0 24px"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(buttonLabel)}</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280">${escapeHtml(COPY[locale].orCopy)}</p>
        <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:#4f46e5">${safeLink}</a></p>
        <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280">${escapeHtml(outro)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

export function passwordResetMail(link: string, ttlMinutes: number, locale: MailLocale = 'en'): Template {
  const copy = COPY[locale].reset;
  const outro = copy.outro(ttlMinutes);
  return {
    subject: copy.subject,
    text: `${copy.textIntro}\n${link}\n\n${outro}\n`,
    html: layout(locale, copy.heading, copy.intro, link, copy.button, outro),
  };
}

export function verifyEmailMail(link: string, ttlHours: number, locale: MailLocale = 'en'): Template {
  const copy = COPY[locale].verify;
  const outro = copy.outro(ttlHours);
  return {
    subject: copy.subject,
    text: `${copy.textIntro}\n${link}\n\n${outro}\n`,
    html: layout(locale, copy.heading, copy.intro, link, copy.button, outro),
  };
}
