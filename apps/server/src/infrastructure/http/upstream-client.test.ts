import { promises as dns } from 'node:dns';
import { hostname } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startOrigin, type FakeOrigin } from '../../test/harness.js';
import { UpstreamClient, UpstreamError } from './upstream-client.js';

/** SSRF and credential-forwarding rules of the single outbound HTTP gateway. */
const config = (allowPrivateNetworks: boolean) => ({
  userAgent: 'test',
  connectTimeoutMs: 2_000,
  headersTimeoutMs: 2_000,
  bodyTimeoutMs: 2_000,
  allowPrivateNetworks,
});

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('UpstreamClient (SSRF)', () => {
  let target: FakeOrigin;
  let redirector: FakeOrigin;
  let lastTargetHeaders: Record<string, unknown> = {};
  const strict = new UpstreamClient(config(false));
  const lan = new UpstreamClient(config(true));

  beforeAll(async () => {
    target = await startOrigin((req, res) => {
      lastTargetHeaders = req.headers;
      res.writeHead(200).end('ok');
    });
    redirector = await startOrigin((req, res) => {
      const location = new URL(req.url ?? '/', 'http://x').searchParams.get('to') ?? '/';
      res.writeHead(302, { location }).end();
    });
  });
  afterAll(async () => {
    await Promise.all([strict.close(), lan.close(), target.close(), redirector.close()]);
  });

  it('refuses loopback / private targets unless private networks are allowed', async () => {
    expect((await failure(strict.request(`${target.url}/`))).kind).toBe('blocked');
    const allowed = await lan.request(`${target.url}/`);
    expect(allowed.status).toBe(200);
    await allowed.body.dump();
  });

  it('checks the resolved address at connect time (a hostname that resolves to loopback is refused)', async () => {
    // The machine's own hostname passes the literal-host check (it is not an IP or "localhost") but
    // resolves to a loopback/private address: the guarded DNS lookup must refuse the connection.
    const name = hostname();
    const resolved = await dns.lookup(name).catch(() => null);
    if (!resolved) return; // hostname not resolvable on this machine: nothing to check
    const port = new URL(target.url).port;
    expect((await failure(strict.request(`http://${name}:${port}/`))).kind).toBe('blocked');
  });

  it('validates every redirect hop: non-http schemes are refused even on a LAN deployment', async () => {
    for (const to of ['file:///etc/passwd', 'gopher://127.0.0.1:70/_x', 'ftp://example.com/']) {
      expect((await failure(lan.request(`${redirector.url}/?to=${encodeURIComponent(to)}`))).kind).toBe('blocked');
    }
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    const response = await lan.request(`${redirector.url}/?to=${encodeURIComponent(`${target.url}/landing`)}`, {
      headers: { cookie: 'session=secret', authorization: 'Basic c2VjcmV0', referer: 'http://x/' },
    });
    await response.body.dump();
    expect(lastTargetHeaders.cookie).toBeUndefined();
    expect(lastTargetHeaders.authorization).toBeUndefined();
    expect(lastTargetHeaders.referer).toBe('http://x/');
  });

  it('stops redirect loops', async () => {
    const loop = `${redirector.url}/?to=${encodeURIComponent(`${redirector.url}/?to=/`)}`;
    expect((await failure(lan.request(loop, { maxRedirects: 2 }))).kind).toBe('redirects');
  });
});
