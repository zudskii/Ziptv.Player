import type { ProviderAdapter, ProviderAdapters, ProviderChannel, ProviderConnection, ProviderHealth, ProviderRecord, ProviderStreamRecord } from '../../application/ports/operator.js';
import type { CatalogBuild, StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import { xtreamStreamUrl } from '../../domain/sources/xtream.js';
import type { M3uProvider } from '../providers/m3u-provider.js';
import type { XtreamProvider } from '../providers/xtream-provider.js';

const HEALTH_TIMEOUT_MS = 20_000;
type OpenLocator = (sealed: string | null) => StreamLocator | null;

const noopContext = (signal: AbortSignal) => ({ signal, onStage: async () => undefined });

function liveChannels(build: CatalogBuild, externalId: (entry: CatalogBuild['live'][number]) => string): ProviderChannel[] {
  return build.live
    .filter((entry) => !entry.unplayableReason)
    .map((entry) => ({
      externalId: externalId(entry),
      name: entry.name,
      tvgId: entry.tvgId,
      groups: entry.groups,
      logo: entry.logo,
      kind: entry.kind,
      locator: entry.locator,
      xtream: entry.xtream ? { id: entry.xtream.id } : null,
    }));
}

async function timed(probe: () => Promise<unknown>): Promise<ProviderHealth> {
  const started = Date.now();
  try {
    await probe();
    return { ok: true, latencyMs: Date.now() - started, message: null };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : 'Unreachable' };
  }
}

function storedLocator(open: OpenLocator, stream: ProviderStreamRecord): StreamLocator {
  const locator = open(stream.locator);
  if (!locator) throw new Error('Stream has no address');
  return locator;
}

/** Licensed M3U feed list (URL behind the provider credential). Keys = the M3U channel keys. */
export class M3uProviderAdapter implements ProviderAdapter {
  constructor(
    private readonly m3u: M3uProvider,
    private readonly openLocator: OpenLocator,
  ) {}

  async listChannels(_provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal) {
    if (connection.type !== 'm3u') throw new Error('M3U provider expects an M3U connection');
    const build = await this.m3u.fetchCatalog({ type: 'm3u_url', url: connection.url }, noopContext(signal));
    return { channels: liveChannels(build, (entry) => entry.key), epgUrls: build.epgUrls };
  }

  async resolveFeed(_provider: ProviderRecord, _connection: ProviderConnection, stream: ProviderStreamRecord): Promise<StreamLocator> {
    return storedLocator(this.openLocator, stream);
  }

  health(provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<ProviderHealth> {
    return timed(() => this.listChannels(provider, connection, AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)])));
  }
}

/** Licensed Xtream account: live streams only; addresses are built from the credential at play time. */
export class XtreamProviderAdapter implements ProviderAdapter {
  constructor(private readonly xtream: XtreamProvider) {}

  async listChannels(_provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal) {
    if (connection.type !== 'xtream') throw new Error('Xtream provider expects an Xtream connection');
    const build = await this.xtream.fetchCatalog({ type: 'xtream', server: connection.server, username: connection.username, password: connection.password }, noopContext(signal));
    return { channels: liveChannels(build, (entry) => `x${entry.xtream?.id ?? entry.key}`), epgUrls: build.epgUrls };
  }

  async resolveFeed(_provider: ProviderRecord, connection: ProviderConnection, stream: ProviderStreamRecord): Promise<StreamLocator> {
    if (connection.type !== 'xtream' || !stream.xtream) throw new Error('Stream has no Xtream id');
    return { url: xtreamStreamUrl(connection, 'live', stream.xtream.id, stream.kind === 'hls' ? 'm3u8' : 'ts'), headers: {} };
  }

  health(_provider: ProviderRecord, connection: ProviderConnection, signal: AbortSignal): Promise<ProviderHealth> {
    if (connection.type !== 'xtream') return Promise.resolve({ ok: false, latencyMs: 0, message: 'Not an Xtream connection' });
    return timed(() => this.xtream.verifyAccount({ type: 'xtream', server: connection.server, username: connection.username, password: connection.password }, signal));
  }
}

interface MockChannel {
  id: string;
  name: string;
  tvgId?: string;
  group?: string;
  logo?: string;
  url: string;
  kind?: StreamKind;
}

/**
 * Development / test provider: the channel list is the provider's `config.channels`
 * (`[{ id, name, url, tvgId?, group?, kind? }]`). Nothing is fetched while listing.
 */
export class MockProviderAdapter implements ProviderAdapter {
  constructor(private readonly openLocator: OpenLocator) {}

  async listChannels(provider: ProviderRecord) {
    const list = Array.isArray(provider.config['channels']) ? (provider.config['channels'] as MockChannel[]) : [];
    const channels: ProviderChannel[] = list
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.url === 'string')
      .map((item) => ({
        externalId: item.id,
        name: item.name,
        tvgId: item.tvgId ?? null,
        groups: item.group ? [item.group] : [],
        logo: item.logo ?? null,
        kind: item.kind ?? 'hls',
        locator: { url: item.url, headers: {} },
        xtream: null,
      }));
    return { channels, epgUrls: [] };
  }

  async resolveFeed(_provider: ProviderRecord, _connection: ProviderConnection, stream: ProviderStreamRecord): Promise<StreamLocator> {
    return storedLocator(this.openLocator, stream);
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, latencyMs: 0, message: null };
  }
}

export function createProviderAdapters(deps: { m3u: M3uProvider; xtream: XtreamProvider; openLocator: OpenLocator }): ProviderAdapters {
  return {
    m3u: new M3uProviderAdapter(deps.m3u, deps.openLocator),
    xtream: new XtreamProviderAdapter(deps.xtream),
    mock: new MockProviderAdapter(deps.openLocator),
  };
}
