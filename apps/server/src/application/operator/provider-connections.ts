import { AppError } from '../errors.js';
import type { ProviderConnection, ProviderRecord } from '../ports/operator.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { UrlPolicy } from '../ports/url-policy.js';

/**
 * Provider connection documents live behind a secret reference (env:ZIPTV_SECRET_* or an
 * encrypted value). They are resolved only server-side, at sync / play time, and never echoed.
 */
export class ProviderConnections {
  constructor(
    private readonly deps: {
      secrets: SecretStore;
      urlPolicy: UrlPolicy;
    },
  ) {}

  async open(provider: ProviderRecord): Promise<ProviderConnection> {
    if (provider.type === 'mock') return { type: 'mock' };
    if (!provider.credential) throw new AppError('CONFLICT', 409, `Provider "${provider.name}" has no credentials yet.`);
    let raw: string;
    try {
      raw = await this.deps.secrets.resolve(provider.credential.secretRef);
    } catch {
      throw new AppError('CONFLICT', 409, `The credentials of provider "${provider.name}" cannot be read (secret reference unresolvable).`);
    }
    return this.parse(provider.type, raw);
  }

  /** Validates a connection document (console input or resolved secret) for a provider type. */
  parse(type: ProviderRecord['type'], raw: string): ProviderConnection {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw AppError.validation('Provider credentials must be a JSON document.');
    }
    const object = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const text = (name: string) => (typeof object[name] === 'string' ? (object[name] as string).trim() : '');
    switch (type) {
      case 'm3u': {
        const url = this.url(text('url'));
        return { type: 'm3u', url: url.href };
      }
      case 'xtream': {
        const server = this.url(text('server'));
        if (!text('username') || !text('password')) throw AppError.validation('Xtream credentials need server, username and password.');
        return { type: 'xtream', server: server.href, username: text('username'), password: text('password') };
      }
      case 'mock':
        return { type: 'mock' };
    }
  }

  /** Host shown in the console (never the path/query, which may hold tokens). */
  hostOf(connection: ProviderConnection): string {
    if (connection.type === 'mock') return 'mock';
    return new URL(connection.type === 'm3u' ? connection.url : connection.server).host;
  }

  private url(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw AppError.validation('Provider address must be an http(s) URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw AppError.validation('Provider address must be an http(s) URL.');
    try {
      this.deps.urlPolicy.assertAllowed(url);
    } catch {
      throw new AppError('UPSTREAM_BLOCKED', 422, 'This address points to a private or local network and cannot be used.');
    }
    return url;
  }
}
