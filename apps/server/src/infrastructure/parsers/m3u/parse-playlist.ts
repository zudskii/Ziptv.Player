import { createContentKeyFactory } from '../../../domain/catalog/content-key.js';
import { decodePlaylistBytes } from './decode.js';
import { scanM3u } from './parse-m3u.js';
import { scanPls } from './parse-pls.js';
import { headersFromAttributes } from './stream-headers.js';
import { detectStreamKind } from './stream-kind.js';
import { parseImageUrl, parseStreamLocation } from './stream-location.js';
import { deriveNameFromUrl, groupIdentity, normalizeLabel } from './text.js';
import { isWebPageUrl } from './web-page.js';
import type { ParsedChannel, ParsedPlaylist, ParseOptions, PlaylistFormat, RawEntry } from './types.js';
import { preview, WarningCollector } from './warnings.js';

export class PlaylistFormatError extends Error {
  constructor(
    message: string,
    readonly reason: 'html_page' | 'hls_manifest_file' | 'binary',
  ) {
    super(message);
    this.name = 'PlaylistFormatError';
  }
}

const DEFAULT_MAX_CHANNELS = 100_000;
const DEFAULT_MAX_WARNINGS = 100;

/** Parses raw playlist bytes (upload or download). */
export function parsePlaylistBytes(bytes: Uint8Array, options: ParseOptions = {}): ParsedPlaylist {
  const { text, encoding } = decodePlaylistBytes(bytes);
  return { ...parsePlaylistText(text, options), encoding };
}

/**
 * Parses playlist text into normalised channels.
 *
 * Guarantees:
 * - every entry that has a usable URL becomes a channel (a missing title is derived, never dropped);
 * - labels are read verbatim (only entities/invisible chars/whitespace are cleaned);
 * - groups that differ only by case/whitespace are merged under the first label seen;
 * - order of the source is preserved.
 */
export function parsePlaylistText(text: string, options: ParseOptions = {}): ParsedPlaylist {
  const warnings = new WarningCollector(options.maxWarnings ?? DEFAULT_MAX_WARNINGS);
  const head = text.slice(0, 1024).trimStart().toLowerCase();
  assertLooksLikeText(head, text);

  let format: PlaylistFormat;
  let entries: RawEntry[];
  let title: string | null = null;
  let epgUrls: string[] = [];
  let headerAttributes: Record<string, string> = {};

  if (head.startsWith('[playlist]')) {
    format = 'pls';
    entries = scanPls(text);
  } else {
    const scan = scanM3u(text, warnings);
    if (scan.isHlsManifest) return hlsManifestResult(options.baseUrl, scan.title);
    format = 'm3u';
    entries = scan.entries;
    title = scan.title;
    epgUrls = scan.epgUrls;
    headerAttributes = scan.headerAttributes;
  }

  const { channels, truncated } = buildChannels(entries, options, warnings);
  return {
    format,
    encoding: 'utf-8',
    title,
    epgUrls,
    headerAttributes,
    channels,
    warnings: warnings.warnings,
    warningCount: warnings.count,
    truncated,
  };
}

function buildChannels(
  entries: RawEntry[],
  options: ParseOptions,
  warnings: WarningCollector,
): { channels: ParsedChannel[]; truncated: boolean } {
  const maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS;
  const nextKey = createContentKeyFactory();
  const groupLabels = new Map<string, string>();
  const channels: ParsedChannel[] = [];

  for (const entry of entries) {
    if (channels.length >= maxChannels) {
      warnings.add(entry.line, 'truncated', `Playlist has more than ${maxChannels} entries; the rest was not imported.`);
      return { channels, truncated: true };
    }

    const location = parseStreamLocation(entry.uri, options.baseUrl);
    if (location.status === 'invalid') {
      warnings.add(entry.line, 'invalid_url', `Skipped "${preview(entry.uri)}": ${location.reason}.`);
      continue;
    }

    const name =
      normalizeLabel(entry.title) || normalizeLabel(entry.attributes['tvg-name']) || deriveNameFromUrl(location.url);
    const groups = unifyGroups(
      entry.attributes['group-title'] || entry.extGroup || entry.attributes['tvg-group'] || '',
      groupLabels,
    );
    const kind = entry.kindHint ?? detectStreamKind(location.url);

    let unplayableReason: ParsedChannel['unplayableReason'] = null;
    if (!location.playable) {
      unplayableReason = 'unsupported_protocol';
      warnings.add(entry.line, 'unsupported_protocol', `"${name}" uses ${location.url.protocol} which browsers cannot play.`);
    } else if (entry.drm) {
      unplayableReason = 'drm';
      warnings.add(entry.line, 'drm_protected', `"${name}" is DRM protected (Widevine/PlayReady license required).`);
    } else if (kind === 'unknown' && isWebPageUrl(location.url)) {
      unplayableReason = 'web_page';
      warnings.add(entry.line, 'web_page', `"${name}" links to a web page (${location.url.hostname}), not a stream.`);
    }

    channels.push({
      key: nextKey({ name, groups }),
      position: channels.length,
      name,
      groups,
      logo: parseImageUrl(entry.attributes['tvg-logo'] || entry.attributes['logo'] || entry.extImage, options.baseUrl),
      tvgId: normalizeLabel(entry.attributes['tvg-id']) || null,
      tvgName: normalizeLabel(entry.attributes['tvg-name']) || null,
      url: location.url.href,
      // Precedence: EXTINF attributes < EXTVLCOPT/EXTHTTP/KODIPROP < `|Header=` on the URL itself.
      headers: { ...headersFromAttributes(entry.attributes), ...entry.headers, ...location.headers },
      kind,
      unplayableReason,
      duration: entry.duration,
      attributes: entry.attributes,
    });
  }

  return { channels, truncated: false };
}

/**
 * Splits `a;b` multi-groups (Kodi / iptv-org convention) and maps every label onto the first
 * spelling seen for it, so `Sports`, `SPORTS` and ` Sports ` end up in one group.
 */
function unifyGroups(raw: string, labels: Map<string, string>): string[] {
  const result: string[] = [];
  for (const part of raw.split(';')) {
    const label = normalizeLabel(part);
    if (!label) continue;
    const identity = groupIdentity(label);
    let canonical = labels.get(identity);
    if (canonical === undefined) {
      canonical = label;
      labels.set(identity, label);
    }
    if (!result.includes(canonical)) result.push(canonical);
  }
  return result;
}

/** A single-stream HLS manifest: importable by URL (one channel), meaningless as an uploaded file. */
function hlsManifestResult(baseUrl: URL | undefined, title: string | null): ParsedPlaylist {
  if (!baseUrl) {
    throw new PlaylistFormatError(
      'This file is an HLS stream manifest (a single stream), not a channel list. Import its URL instead.',
      'hls_manifest_file',
    );
  }
  const name = title || deriveNameFromUrl(baseUrl);
  const channel: ParsedChannel = {
    key: createContentKeyFactory()({ name, groups: [] }),
    position: 0,
    name,
    groups: [],
    logo: null,
    tvgId: null,
    tvgName: null,
    url: baseUrl.href,
    headers: {},
    kind: 'hls',
    unplayableReason: null,
    duration: -1,
    attributes: {},
  };
  return {
    format: 'hls-manifest',
    encoding: 'utf-8',
    title,
    epgUrls: [],
    headerAttributes: {},
    channels: [channel],
    warnings: [],
    warningCount: 0,
    truncated: false,
  };
}

function assertLooksLikeText(head: string, text: string): void {
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(head)) {
    throw new PlaylistFormatError(
      'The source returned an HTML page instead of a playlist (wrong URL, expired subscription or a login page).',
      'html_page',
    );
  }
  // Binary data (zip, image, video) decoded as text is full of replacement/control chars.
  const sample = text.slice(0, 2048);
  if (sample.length > 0) {
    let suspicious = 0;
    for (const ch of sample) {
      const code = ch.charCodeAt(0);
      if (ch === '�' || (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t')) suspicious++;
    }
    if (suspicious / sample.length > 0.1) {
      throw new PlaylistFormatError('The file is binary data, not a text playlist.', 'binary');
    }
  }
}
