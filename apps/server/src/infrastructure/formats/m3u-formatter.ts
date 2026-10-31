import type { ExportedChannel, PlaylistFormatter } from '../../application/ports/playlist-formatter.js';
import type { StreamHeaders } from '../../domain/catalog/model.js';

/** Header option names players understand; the same names our own importer reads back. */
const HEADER_OPTIONS: [keyof StreamHeaders, string][] = [
  ['user-agent', 'http-user-agent'],
  ['referer', 'http-referrer'],
  ['origin', 'http-origin'],
  ['cookie', 'http-cookie'],
  ['authorization', 'http-authorization'],
];

/** One line, no quotes: values go inside `key="…"` and must not break the line or the attribute. */
const attribute = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

/**
 *   #EXTINF:-1 tvg-id="…" tvg-chno="5" tvg-logo="…" group-title="News" catchup="shift" catchup-days="3",Name
 *   #EXTVLCOPT:http-user-agent=…
 *   http://stream
 *
 * Attributes are only written when there is a value. Headers a stream needs become
 * `#EXTVLCOPT` lines (VLC and many TV apps honour them).
 */
export class M3uFormatter implements PlaylistFormatter {
  readonly contentType = 'audio/x-mpegurl; charset=utf-8';

  header(): string {
    return '#EXTM3U\n';
  }

  channel(channel: ExportedChannel): string {
    const attributes: string[] = [];
    if (channel.tvgId) attributes.push(`tvg-id="${attribute(channel.tvgId)}"`);
    if (channel.number !== null) attributes.push(`tvg-chno="${channel.number}"`);
    if (channel.logo) attributes.push(`tvg-logo="${attribute(channel.logo)}"`);
    if (channel.groupName) attributes.push(`group-title="${attribute(channel.groupName)}"`);
    // Xtream archives need the account; every other mode is a plain M3U convention.
    if (channel.catchup && channel.catchup.mode !== 'xtream') {
      attributes.push(`catchup="${channel.catchup.mode}"`, `catchup-days="${channel.catchup.days}"`);
      if (channel.catchup.template) attributes.push(`catchup-source="${attribute(channel.catchup.template)}"`);
    }

    let text = `#EXTINF:-1${attributes.length ? ` ${attributes.join(' ')}` : ''},${oneLine(channel.name)}\n`;
    for (const [header, option] of HEADER_OPTIONS) {
      const value = channel.headers[header];
      if (value) text += `#EXTVLCOPT:${option}=${oneLine(value)}\n`;
    }
    return `${text}${oneLine(channel.url)}\n`;
  }
}
