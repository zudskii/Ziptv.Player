/**
 * Hosts whose URLs are web pages / embeds, not media streams. A `<video>` element (or any
 * media engine) can never play them, so they are flagged instead of failing at play time.
 */
const WEB_PAGE_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'twitch.tv',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'tiktok.com',
  'vk.com',
  'ok.ru',
  'rutube.ru',
  'dailymotion.com',
  'vimeo.com',
];

export function isWebPageUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return WEB_PAGE_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
