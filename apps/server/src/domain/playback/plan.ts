import type { StreamHeaders, StreamKind } from '../catalog/model.js';

export type EngineName = 'hls' | 'mpegts' | 'flv' | 'native' | 'dash';

export interface Candidate {
  engine: EngineName;
  url: string;
  via: 'direct' | 'proxy';
}

const ENGINES_BY_KIND: Record<StreamKind, EngineName[]> = {
  hls: ['hls'],
  dash: ['dash'],
  mpegts: ['mpegts'],
  flv: ['flv'],
  progressive: ['native'],
  // Could not be identified: try the formats IPTV panels actually serve, most likely first.
  unknown: ['hls', 'mpegts', 'native'],
};

export interface PlanInput {
  kind: StreamKind;
  url: string;
  headers: StreamHeaders;
  /** The page is https: plain-http streams cannot be fetched directly (mixed content). */
  secureContext: boolean;
  proxyEnabled: boolean;
  /** Issues a signed proxy URL for the stream. */
  proxyUrl: () => string;
}

/**
 * Decides *how* a stream is played; the client tries the candidates in order.
 *
 * - direct first (no server bandwidth), unless the browser cannot possibly fetch it directly:
 *   plain http on an https page (mixed content) or headers a browser cannot set (User-Agent,
 *   Referer, Cookie…) — then the proxy goes first;
 * - proxy as fallback for CORS failures;
 * - DASH manifests reference segments relatively and the proxy only rewrites HLS → direct only.
 */
export function planCandidates(input: PlanInput): Candidate[] {
  const mixedContent = input.secureContext && input.url.startsWith('http:');
  const needsHeaders = Object.keys(input.headers).length > 0;
  const canDirect = !mixedContent;
  const canProxy = input.proxyEnabled && input.kind !== 'dash';
  const proxyFirst = needsHeaders || mixedContent;

  let proxied: string | null = null;
  const proxyUrl = () => (proxied ??= input.proxyUrl());

  const candidates: Candidate[] = [];
  for (const engine of ENGINES_BY_KIND[input.kind]) {
    const direct: Candidate = { engine, url: input.url, via: 'direct' };
    if (proxyFirst) {
      if (canProxy) candidates.push({ engine, url: proxyUrl(), via: 'proxy' });
      if (canDirect) candidates.push(direct);
    } else {
      if (canDirect) candidates.push(direct);
      if (canProxy) candidates.push({ engine, url: proxyUrl(), via: 'proxy' });
    }
  }
  return candidates;
}

/** Container of a VOD file from its extension (Xtream `container_extension`). */
export function kindFromExtension(extension: string | null | undefined): StreamKind {
  switch ((extension ?? '').toLowerCase()) {
    case 'm3u8':
      return 'hls';
    case 'ts':
      return 'mpegts';
    case 'mpd':
      return 'dash';
    case 'flv':
      return 'flv';
    case 'mp4':
    case 'm4v':
    case 'mov':
    case 'webm':
    case 'mkv':
    case 'ogv':
    case 'mp3':
    case 'aac':
      return 'progressive';
    default:
      return 'unknown';
  }
}
