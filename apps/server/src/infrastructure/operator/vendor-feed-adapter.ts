import { z } from 'zod';

import type { FeedSignatures } from '../../application/ports/feed-signatures.js';
import type { ProviderAdapter, ProviderCatalogDelta, ProviderChannel, ProviderConnection, ProviderHealth, ProviderRecord, ProviderStreamRecord, ProviderVodItem } from '../../application/ports/operator.js';
import { buildCatchupUrl } from '../../domain/catalog/catchup-url.js';
import type { CatchupInfo, StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import { checkRight, FEED_LIMITS, QUALITIES, VENDOR_FEED_VERSION, type FeedIssue, type FeedRight } from '../../domain/operator/vendor-feed.js';
import type { UpstreamClient } from '../http/upstream-client.js';

const FETCH_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 20_000;
export const SIGNATURE_HEADER = 'x-ziptv-signature';

type OpenLocator = (sealed: string | null) => StreamLocator | null;

/** A refused feed (bad signature, wrong provider, malformed document): nothing of it is applied. */
export class VendorFeedError extends Error {
  constructor(
    readonly code: 'signature_missing' | 'signature_invalid' | 'malformed' | 'wrong_provider' | 'unsupported_version' | 'too_large' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'VendorFeedError';
  }
}

// --- wire format (contract v1) ---------------------------------------------------------------

const Id = z.string().trim().min(1).max(200);
const Url = z.string().url().max(4_096).refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');
const Stream = z.object({ url: Url, headers: z.record(z.string().max(64), z.string().max(1_024)).optional() }).strict();
const WireRight = z
  .object({
    territories: z.array(z.string().max(16)).max(250),
    devices: z.array(z.string().max(16)).max(8),
    models: z.array(z.string().max(16)).max(8),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }).nullable().optional(),
    catchupDays: z.number().int().optional(),
    maxQuality: z.enum(QUALITIES).nullable().optional(),
  })
  .strict();
const WireChannel = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(300),
    tvgId: z.string().max(200).nullable().optional(),
    logo: Url.nullable().optional(),
    groups: z.array(z.string().max(120)).max(20).optional(),
    stream: Stream,
    catchup: z.object({ days: z.number().int().min(1).max(30), mode: z.enum(['shift', 'xc', 'append', 'flussonic']), template: z.string().max(2_000).nullable().optional() }).strict().nullable().optional(),
    rights: z.array(WireRight).max(FEED_LIMITS.maxRightsPerItem).optional(),
    packages: z.array(Id).max(100).optional(),
  })
  .strict();
const WireEpisode = z.object({ id: Id, season: z.number().int().min(0).max(1_000), episode: z.number().int().min(0).max(10_000), title: z.string().trim().min(1).max(300), durationSecs: z.number().positive().max(86_400).nullable().optional(), stream: Stream }).strict();
const WireVod = z
  .object({
    id: Id,
    type: z.enum(['movie', 'series']),
    title: z.string().trim().min(1).max(300),
    year: z.number().int().min(1880).max(2100).nullable().optional(),
    genres: z.array(z.string().max(60)).max(20).optional(),
    poster: Url.nullable().optional(),
    plot: z.string().max(5_000).nullable().optional(),
    durationSecs: z.number().positive().max(86_400).nullable().optional(),
    rating: z.number().min(0).max(10).nullable().optional(),
    stream: Stream.nullable().optional(),
    episodes: z.array(WireEpisode).max(5_000).optional(),
    rights: z.array(WireRight).max(FEED_LIMITS.maxRightsPerItem).optional(),
    packages: z.array(Id).max(100).optional(),
  })
  .strict()
  .refine((item) => (item.type === 'movie' ? Boolean(item.stream) : true), 'a movie needs a stream');
const WirePackage = z.object({ id: Id, name: z.string().trim().min(1).max(200), description: z.string().max(2_000).nullable().optional() }).strict();

/** The document; items stay `unknown` here so one bad item does not refuse the feed. */
const WireFeed = z
  .object({
    version: z.number().int(),
    provider: z.object({ id: Id }).passthrough(),
    generatedAt: z.string().datetime({ offset: true }),
    cursor: z.string().min(1).max(500),
    full: z.boolean(),
    channels: z.array(z.unknown()).max(FEED_LIMITS.maxItems).optional(),
    vod: z.array(z.unknown()).max(FEED_LIMITS.maxItems).optional(),
    packages: z.array(z.unknown()).max(10_000).optional(),
    deleted: z.object({ channels: z.array(Id).optional(), vod: z.array(Id).optional(), packages: z.array(Id).optional() }).strict().optional(),
    epg: z.object({ xmltvUrls: z.array(Url).max(10).optional() }).strict().optional(),
  })
  .passthrough();

/**
 * ZIPTV Vendor Feed v1 (docs/vendor-feed-v1.md): the provider-agnostic way a licensed content
 * provider delivers channels, movies, series, packages and the rights for each — signed, and
 * incremental. Mode A (vendor-managed rights) and Mode B (ingest only) use the same format; what
 * the console does with the rights is decided per provider contract, not here.
 *
 * Trust: the body is verified against the provider's configured Ed25519 keys *before* it is parsed,
 * and the feed must name the provider it was configured for (`provider.id` = the provider's slug).
 */
export class VendorFeedAdapter implements ProviderAdapter {
  constructor(
    private readonly deps: {
      upstream: Pick<UpstreamClient, 'fetchBytes'>;
      signatures: FeedSignatures;
      openLocator: OpenLocator;
    },
  ) {}

  async fetchCatalog(provider: ProviderRecord, connection: ProviderConnection, cursor: string | null, signal: AbortSignal): Promise<ProviderCatalogDelta> {
    const body = await this.download(connection, cursor, signal);
    return this.parse(provider, body.bytes, body.signature);
  }

  async listChannels(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<{ channels: ProviderChannel[]; epgUrls: string[] }> {
    const delta = await this.fetchCatalog(provider, connection, null, signal);
    return { channels: delta.channels, epgUrls: delta.epgUrls };
  }

  async resolveFeed(_provider: ProviderRecord, _connection: ProviderConnection, stream: ProviderStreamRecord): Promise<StreamLocator> {
    const locator = this.deps.openLocator(stream.locator);
    if (!locator) throw new Error('Stream has no address');
    return locator;
  }

  async resolveArchive(_provider: ProviderRecord, _connection: ProviderConnection, stream: ProviderStreamRecord, times: { start: Date; end: Date; now: Date }): Promise<StreamLocator | null> {
    if (!stream.catchup || stream.catchup.mode === 'xtream') return null;
    const live = this.deps.openLocator(stream.locator);
    if (!live) return null;
    const url = buildCatchupUrl(stream.catchup, live.url, times);
    return url ? { url, headers: live.headers } : null;
  }

  /** Reachable, signed by a configured key and well-formed (the current position, so it stays small). */
  async health(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.fetchCatalog(provider, connection, provider.feed.cursor, AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]));
      return { ok: true, latencyMs: Date.now() - started, message: null };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : 'Unreachable' };
    }
  }

  private async download(connection: ProviderConnection, cursor: string | null, signal: AbortSignal): Promise<{ bytes: Buffer; signature: string | null }> {
    if (connection.type !== 'vendor_feed') throw new Error('Vendor feed adapter expects a vendor_feed connection');
    const url = new URL(connection.url);
    if (cursor) url.searchParams.set('since', cursor);
    try {
      const { bytes, response } = await this.deps.upstream.fetchBytes(url, FEED_LIMITS.maxBytes, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { accept: 'application/json', ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) },
      });
      const header = response.headers[SIGNATURE_HEADER];
      return { bytes, signature: (Array.isArray(header) ? header[0] : header) ?? null };
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : 'unreachable';
      throw new VendorFeedError(/larger than/.test(message) ? 'too_large' : 'unreachable', `The feed could not be downloaded: ${message}`);
    }
  }

  /** Exported for tests: verification + parsing of one downloaded feed. */
  parse(provider: ProviderRecord, bytes: Buffer, signatureHeader: string | null): ProviderCatalogDelta {
    this.verify(provider, bytes, signatureHeader);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new VendorFeedError('malformed', 'The feed is not valid JSON.');
    }
    const document = WireFeed.safeParse(json);
    if (!document.success) throw new VendorFeedError('malformed', `The feed does not follow contract v${VENDOR_FEED_VERSION}: ${describe(document.error)}`);
    const feed = document.data;
    if (feed.version !== VENDOR_FEED_VERSION) throw new VendorFeedError('unsupported_version', `Feed version ${feed.version} is not supported (expected ${VENDOR_FEED_VERSION}).`);
    if (feed.provider.id !== provider.slug) throw new VendorFeedError('wrong_provider', `The feed is for provider "${feed.provider.id}", not "${provider.slug}".`);

    const issues: FeedIssue[] = [];
    const seen = new Set<string>();
    const unique = (kind: string, id: string, path: string) => {
      if (seen.has(`${kind}:${id}`)) {
        issues.push({ path, message: `duplicate id "${id}" (the first one is used)` });
        return false;
      }
      seen.add(`${kind}:${id}`);
      return true;
    };

    const channels: ProviderChannel[] = [];
    const channelPackages = new Map<string, string[]>();
    (feed.channels ?? []).forEach((raw, index) => {
      const path = `channels[${index}]`;
      const item = WireChannel.safeParse(raw);
      if (!item.success) return issues.push({ path, message: describe(item.error) });
      const rights = this.rights(item.data.rights, path, issues);
      if (rights === null || !unique('channel', item.data.id, path)) return;
      channelPackages.set(item.data.id, item.data.packages ?? []);
      channels.push({
        externalId: item.data.id,
        name: item.data.name,
        tvgId: item.data.tvgId ?? null,
        groups: item.data.groups ?? [],
        logo: item.data.logo ?? null,
        kind: streamKind(item.data.stream.url),
        locator: { url: item.data.stream.url, headers: item.data.stream.headers ?? {} },
        xtream: null,
        catchup: item.data.catchup ? catchupInfo(item.data.catchup) : null,
        rights: item.data.rights === undefined ? null : rights,
      });
    });

    const vod: ProviderVodItem[] = [];
    (feed.vod ?? []).forEach((raw, index) => {
      const path = `vod[${index}]`;
      const item = WireVod.safeParse(raw);
      if (!item.success) return issues.push({ path, message: describe(item.error) });
      const rights = this.rights(item.data.rights, path, issues);
      if (rights === null || !unique('vod', item.data.id, path)) return;
      vod.push({
        externalId: item.data.id,
        type: item.data.type,
        title: item.data.title,
        year: item.data.year ?? null,
        genres: item.data.genres ?? [],
        poster: item.data.poster ?? null,
        plot: item.data.plot ?? null,
        durationSecs: item.data.durationSecs ?? null,
        rating: item.data.rating ?? null,
        locator: item.data.stream ? { url: item.data.stream.url, headers: item.data.stream.headers ?? {} } : null,
        episodes: (item.data.episodes ?? []).map((episode) => ({
          externalId: episode.id,
          season: episode.season,
          episode: episode.episode,
          title: episode.title,
          durationSecs: episode.durationSecs ?? null,
          locator: { url: episode.stream.url, headers: episode.stream.headers ?? {} },
        })),
        rights,
        packages: item.data.packages ?? [],
      });
    });

    const packages: ProviderCatalogDelta['packages'] = [];
    (feed.packages ?? []).forEach((raw, index) => {
      const path = `packages[${index}]`;
      const item = WirePackage.safeParse(raw);
      if (!item.success) return issues.push({ path, message: describe(item.error) });
      if (!unique('package', item.data.id, path)) return;
      packages.push({
        externalId: item.data.id,
        name: item.data.name,
        description: item.data.description ?? null,
        channelIds: [...channelPackages].filter(([, member]) => member.includes(item.data.id)).map(([channelId]) => channelId),
        vodIds: vod.filter((entry) => entry.packages.includes(item.data.id)).map((entry) => entry.externalId),
      });
    });

    return {
      full: feed.full,
      cursor: feed.cursor,
      generatedAt: new Date(feed.generatedAt),
      channels,
      vod,
      packages,
      deleted: { channels: feed.deleted?.channels ?? [], vod: feed.deleted?.vod ?? [], packages: feed.deleted?.packages ?? [] },
      epgUrls: feed.epg?.xmltvUrls ?? [],
      issues,
    };
  }

  /** `X-Ziptv-Signature: keyId=<id>, sig=<base64>` checked against the provider's keys. */
  private verify(provider: ProviderRecord, bytes: Buffer, header: string | null): void {
    if (!header) throw new VendorFeedError('signature_missing', 'The feed is not signed (X-Ziptv-Signature header missing).');
    const parts = Object.fromEntries(
      header.split(',').map((part) => {
        const at = part.indexOf('=');
        return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
      }),
    );
    const keys = Array.isArray(provider.config['publicKeys']) ? (provider.config['publicKeys'] as { id?: unknown; key?: unknown }[]) : [];
    const key = keys.find((entry) => entry.id === parts['keyId']);
    if (!key || typeof key.key !== 'string') throw new VendorFeedError('signature_invalid', `The feed is signed with key "${String(parts['keyId'] ?? '')}", which is not configured for this provider.`);
    if (!parts['sig'] || !this.deps.signatures.verify(bytes, parts['sig'], key.key)) throw new VendorFeedError('signature_invalid', 'The feed signature does not match its content.');
  }

  /** Validated rights of an item, or null (item skipped) when one of them is invalid. */
  private rights(input: z.infer<typeof WireRight>[] | undefined, path: string, issues: FeedIssue[]): FeedRight[] | null {
    const rights: FeedRight[] = [];
    for (const [index, raw] of (input ?? []).entries()) {
      const right: FeedRight = {
        territories: raw.territories.map((territory) => territory.toUpperCase()),
        devices: raw.devices as FeedRight['devices'],
        models: raw.models as FeedRight['models'],
        start: new Date(raw.start),
        end: raw.end ? new Date(raw.end) : null,
        catchupDays: raw.catchupDays ?? 0,
        maxQuality: raw.maxQuality ?? null,
      };
      const problem = checkRight(right);
      if (problem) {
        issues.push({ path: `${path}.rights[${index}]`, message: problem });
        return null;
      }
      rights.push(right);
    }
    return rights;
  }
}

function catchupInfo(input: { days: number; mode: 'shift' | 'xc' | 'append' | 'flussonic'; template?: string | null | undefined }): CatchupInfo {
  // "xc" in the contract = the Xtream-style timeshift path; stored like an M3U "default" template.
  return input.mode === 'xc' ? { mode: 'default', days: input.days, template: input.template ?? null } : { mode: input.mode, days: input.days, template: input.template ?? null };
}

function streamKind(url: string): StreamKind {
  const path = url.split('?')[0]!.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.ts')) return 'mpegts';
  if (path.endsWith('.flv')) return 'flv';
  if (/\.(mp4|mkv|m4v|mov|webm)$/.test(path)) return 'progressive';
  return 'hls';
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
