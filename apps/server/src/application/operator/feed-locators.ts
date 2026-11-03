import type { StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import type { OperatorCatalogRepository, ProviderAdapters } from '../ports/operator.js';
import type { ProviderConnections } from './provider-connections.js';

/**
 * Upstream address of a feed, built server-side from the provider connection (secret) and the
 * stream — for the stream proxy and the probe fleet only; it never leaves the server.
 */
export class FeedLocators {
  constructor(
    private readonly deps: {
      catalog: Pick<OperatorCatalogRepository, 'findStream' | 'findProvider'>;
      adapters: ProviderAdapters;
      connections: ProviderConnections;
    },
  ) {}

  /** null when the stream or provider no longer exists. Throws when the connection is unusable. */
  async locate(feed: { providerId: string; providerStreamId: string }): Promise<{ locator: StreamLocator; kind: StreamKind } | null> {
    const [stream, provider] = await Promise.all([this.deps.catalog.findStream(feed.providerStreamId), this.deps.catalog.findProvider(feed.providerId)]);
    if (!stream || !provider) return null;
    const connection = await this.deps.connections.open(provider);
    const locator = await this.deps.adapters[provider.type].resolveFeed(provider, connection, stream);
    return { locator, kind: stream.kind };
  }

  /** Archive address of [start, end) on the feed's stream; null when it has no usable archive. */
  async locateArchive(feed: { providerId: string; providerStreamId: string }, times: { start: Date; end: Date; now: Date }): Promise<{ locator: StreamLocator; kind: StreamKind } | null> {
    const [stream, provider] = await Promise.all([this.deps.catalog.findStream(feed.providerStreamId), this.deps.catalog.findProvider(feed.providerId)]);
    if (!stream?.catchup || !provider) return null;
    const connection = await this.deps.connections.open(provider);
    const locator = await this.deps.adapters[provider.type].resolveArchive(provider, connection, stream, times);
    if (!locator) return null;
    const path = new URL(locator.url).pathname.toLowerCase();
    return { locator, kind: path.endsWith('.m3u8') ? 'hls' : path.endsWith('.ts') ? 'mpegts' : stream.kind };
  }
}
