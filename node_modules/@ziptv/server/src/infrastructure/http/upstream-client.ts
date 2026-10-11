import type { IncomingHttpHeaders } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { Agent, request } from 'undici';

import type { AppConfig } from '../../config/env.js';
import { destroyQuietly } from '../streams/destroy.js';
import { assertUpstreamUrlAllowed, BlockedAddressError, createGuardedLookup } from './network-policy.js';

export type UpstreamErrorKind = 'blocked' | 'timeout' | 'network' | 'too_large' | 'status' | 'redirects';

/** Normalised failure of an outbound request; services map it to an API error. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamRequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Override the agent-wide body timeout (e.g. short for probes). */
  bodyTimeoutMs?: number;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Final URL after redirects — the base for resolving relative URIs in the body. */
  url: URL;
  body: Readable & { dump(opts?: { limit: number }): Promise<void> };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['cookie', 'authorization'];

/**
 * The single gateway for outbound HTTP. Enforces the SSRF policy on every hop, follows
 * redirects manually (so each hop is validated and credentials are not leaked cross-origin),
 * applies timeouts and a default "player" User-Agent.
 */
export class UpstreamClient {
  private readonly agent: Agent;

  constructor(private readonly config: AppConfig['upstream']) {
    this.agent = new Agent({
      connect: {
        timeout: config.connectTimeoutMs,
        lookup: createGuardedLookup(config.allowPrivateNetworks),
      },
      headersTimeout: config.headersTimeoutMs,
      bodyTimeout: config.bodyTimeoutMs,
      keepAliveTimeout: 10_000,
      connections: 256,
    });
  }

  async request(target: URL | string, options: UpstreamRequestOptions = {}): Promise<UpstreamResponse> {
    let url = typeof target === 'string' ? new URL(target) : target;
    let method = options.method ?? 'GET';
    let headers = this.buildHeaders(options.headers);
    const maxRedirects = options.maxRedirects ?? 5;

    for (let hop = 0; ; hop++) {
      let response;
      try {
        assertUpstreamUrlAllowed(url, this.config.allowPrivateNetworks);
        response = await request(url, {
          method,
          headers,
          dispatcher: this.agent,
          signal: options.signal,
          bodyTimeout: options.bodyTimeoutMs ?? this.config.bodyTimeoutMs,
        });
      } catch (error) {
        throw toUpstreamError(error, url);
      }

      const location = firstHeader(response.headers.location);
      if (REDIRECT_STATUSES.has(response.statusCode) && location) {
        destroyQuietly(response.body);
        if (hop >= maxRedirects) throw new UpstreamError('redirects', `Too many redirects (>${maxRedirects})`);
        const next = new URL(location, url);
        if (next.origin !== url.origin) headers = withoutCredentials(headers);
        if (response.statusCode === 303) method = 'GET';
        url = next;
        continue;
      }

      return { status: response.statusCode, headers: response.headers, url, body: response.body };
    }
  }

  /**
   * Downloads a whole (text) body with a hard size cap that also applies after decompression,
   * so a gzip bomb cannot exhaust memory.
   */
  async fetchBytes(
    target: URL | string,
    maxBytes: number,
    options: UpstreamRequestOptions = {},
  ): Promise<{ bytes: Buffer; response: Omit<UpstreamResponse, 'body'> }> {
    const response = await this.request(target, {
      ...options,
      headers: { 'accept-encoding': 'gzip, deflate, br', ...options.headers },
    });
    const { body, ...meta } = response;

    if (response.status >= 400) {
      destroyQuietly(body);
      throw new UpstreamError('status', `Upstream responded with HTTP ${response.status}`, response.status);
    }
    const declared = Number(firstHeader(response.headers['content-length']));
    if (Number.isFinite(declared) && declared > maxBytes) {
      destroyQuietly(body);
      throw new UpstreamError('too_large', `Upstream body is larger than ${maxBytes} bytes`);
    }

    const stream = decodeContent(body, firstHeader(response.headers['content-encoding']));
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) {
          destroyQuietly(stream);
          destroyQuietly(body);
          throw new UpstreamError('too_large', `Upstream body is larger than ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      throw error instanceof UpstreamError ? error : toUpstreamError(error, response.url);
    }
    return { bytes: Buffer.concat(chunks, total), response: meta };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private buildHeaders(extra: UpstreamRequestOptions['headers']): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.config.userAgent,
      accept: '*/*',
      'accept-encoding': 'identity',
    };
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (value) headers[name.toLowerCase()] = value;
    }
    return headers;
  }
}

export function isContentEncoded(encoding: string | undefined): boolean {
  const normalized = encoding?.trim().toLowerCase();
  return !!normalized && normalized !== 'identity';
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  for (const name of CREDENTIAL_HEADERS) delete copy[name];
  return copy;
}

/** Wraps a body in a decompressor matching `Content-Encoding` (identity → unchanged). */
export function decodeContent(body: Readable, encoding: string | undefined): Readable {
  const normalized = encoding?.trim().toLowerCase();
  const decoder =
    normalized === 'gzip' || normalized === 'x-gzip'
      ? createGunzip()
      : normalized === 'deflate'
        ? createInflate()
        : normalized === 'br'
          ? createBrotliDecompress()
          : null;
  if (!decoder) return body;
  return pipeline(body, decoder, () => undefined);
}

function toUpstreamError(error: unknown, url: URL): UpstreamError {
  if (error instanceof UpstreamError) return error;
  const chain: unknown[] = [];
  for (let current: unknown = error; current && chain.length < 5; current = (current as { cause?: unknown }).cause) {
    chain.push(current);
  }
  if (chain.some((item) => item instanceof BlockedAddressError)) {
    const blocked = chain.find((item) => item instanceof BlockedAddressError) as BlockedAddressError;
    return new UpstreamError('blocked', blocked.message, undefined, { cause: error });
  }
  const code = chain.map((item) => (item as { code?: string }).code).find(Boolean);
  if (code && /TIMEOUT/i.test(code)) {
    return new UpstreamError('timeout', `Timed out while contacting ${url.host}`, undefined, { cause: error });
  }
  const reason = code ?? (error instanceof Error ? error.message : 'unknown error');
  return new UpstreamError('network', `Could not reach ${url.host} (${reason})`, undefined, { cause: error });
}
