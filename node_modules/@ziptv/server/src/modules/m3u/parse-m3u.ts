import { parseAttributeList, parseExtinf, type ExtinfLine } from './attributes.js';
import { parseExtHttp, parseKodiHeaderString, setStreamHeader } from './stream-headers.js';
import { normalizeLabel } from './text.js';
import type { RawEntry, StreamHeaders, StreamKind } from './types.js';
import { preview, type WarningCollector } from './warnings.js';

export interface M3uScanResult {
  entries: RawEntry[];
  title: string | null;
  epgUrls: string[];
  /** The text is an HLS media/master playlist (a single stream), not a channel list. */
  isHlsManifest: boolean;
}

/** Tags that only exist in HLS stream manifests, never in IPTV channel lists. */
const HLS_MANIFEST_TAGS = new Set(['#EXT-X-TARGETDURATION', '#EXT-X-STREAM-INF', '#EXT-X-MEDIA-SEQUENCE']);
const EPG_ATTRIBUTES = ['url-tvg', 'x-tvg-url', 'tvg-url'];

interface PendingEntry {
  firstLine: number;
  extinf: ExtinfLine | null;
  extGroup: string | null;
  extImage: string | null;
  headers: StreamHeaders;
  drm: boolean;
  kindHint: StreamKind | null;
}

function emptyPending(): PendingEntry {
  return { firstLine: 0, extinf: null, extGroup: null, extImage: null, headers: {}, drm: false, kindHint: null };
}

/**
 * Line scanner for extended and plain M3U.
 *
 * Rule: every directive between two URI lines belongs to the next URI. That is how
 * `#EXTVLCOPT`, `#EXTGRP`, `#KODIPROP` and `#EXTHTTP` lines are attached to their channel
 * instead of being mistaken for separate entries.
 */
export function scanM3u(text: string, warnings: WarningCollector): M3uScanResult {
  const lines = text.split(/\r\n|\r|\n/);
  const entries: RawEntry[] = [];
  const epgUrls = new Set<string>();
  let title: string | null = null;
  let isHlsManifest = false;
  let pending = emptyPending();

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    let line = (lines[index] ?? '').trim();
    if (!line) continue;

    // Broken exports sometimes lose the leading '#'.
    if (/^EXTINF:/i.test(line)) line = `#${line}`;

    if (!line.startsWith('#')) {
      entries.push(toRawEntry(pending, line, lineNumber));
      pending = emptyPending();
      continue;
    }

    const colon = line.indexOf(':');
    const space = line.search(/\s/);
    const nameEnd = [colon, space].filter((i) => i !== -1).reduce((a, b) => Math.min(a, b), line.length);
    const directive = line.slice(0, nameEnd).toUpperCase();
    const value = colon === -1 ? '' : line.slice(colon + 1).trim();

    if (HLS_MANIFEST_TAGS.has(directive)) isHlsManifest = true;
    if (pending.firstLine === 0 && directive !== '#EXTM3U') pending.firstLine = lineNumber;

    switch (directive) {
      case '#EXTM3U': {
        const attributes = parseAttributeList(line.slice('#EXTM3U'.length));
        for (const key of EPG_ATTRIBUTES) {
          for (const url of (attributes[key] ?? '').split(',')) {
            const trimmed = url.trim();
            if (/^https?:\/\//i.test(trimmed)) epgUrls.add(trimmed);
          }
        }
        break;
      }
      case '#EXTINF': {
        if (pending.extinf) {
          warnings.add(pending.firstLine, 'orphan_extinf', 'An #EXTINF entry has no stream URL; it was skipped.');
          pending = { ...emptyPending(), firstLine: lineNumber };
        }
        pending.extinf = parseExtinf(value);
        break;
      }
      case '#EXTGRP':
        pending.extGroup = value || null;
        break;
      case '#EXTIMG':
        pending.extImage = value || null;
        break;
      case '#PLAYLIST':
        title = normalizeLabel(value) || title;
        break;
      case '#EXTVLCOPT':
        applyKeyValue(value, (key, optionValue) => setStreamHeader(pending.headers, key, optionValue));
        break;
      case '#EXTHTTP': {
        const headers = parseExtHttp(value);
        if (headers) Object.assign(pending.headers, headers);
        else warnings.add(lineNumber, 'invalid_directive', `#EXTHTTP is not valid JSON: ${preview(value, 60)}`);
        break;
      }
      case '#KODIPROP':
        applyKeyValue(value, (key, propValue) => applyKodiProperty(pending, key, propValue));
        break;
      default:
        // Plain comments and unknown directives are ignored on purpose.
        break;
    }
  }

  if (pending.extinf) {
    warnings.add(pending.firstLine, 'orphan_extinf', 'The last #EXTINF entry has no stream URL; it was skipped.');
  }

  return { entries, title, epgUrls: [...epgUrls], isHlsManifest };
}

function toRawEntry(pending: PendingEntry, uri: string, lineNumber: number): RawEntry {
  return {
    line: pending.firstLine || lineNumber,
    uri,
    title: pending.extinf?.title ?? '',
    duration: pending.extinf?.duration ?? -1,
    attributes: pending.extinf?.attributes ?? {},
    extGroup: pending.extGroup,
    extImage: pending.extImage,
    headers: pending.headers,
    drm: pending.drm,
    kindHint: pending.kindHint,
  };
}

function applyKeyValue(input: string, apply: (key: string, value: string) => void): void {
  const separator = input.indexOf('=');
  if (separator <= 0) return;
  apply(input.slice(0, separator).trim().toLowerCase(), input.slice(separator + 1).trim());
}

function applyKodiProperty(pending: PendingEntry, key: string, value: string): void {
  switch (key) {
    case 'inputstream.adaptive.stream_headers':
    case 'inputstream.adaptive.manifest_headers':
    case 'inputstream.adaptive.common_headers':
      Object.assign(pending.headers, parseKodiHeaderString(value));
      break;
    case 'inputstream.adaptive.license_type':
    case 'inputstream.adaptive.license_key':
    case 'inputstream.adaptive.drm':
    case 'inputstream.adaptive.drm_legacy':
      if (value) pending.drm = true;
      break;
    case 'inputstream.adaptive.manifest_type': {
      const type = value.toLowerCase();
      if (type === 'mpd') pending.kindHint = 'dash';
      else if (type === 'hls') pending.kindHint = 'hls';
      break;
    }
    default:
      break;
  }
}
