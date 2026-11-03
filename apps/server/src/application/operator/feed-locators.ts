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
}
