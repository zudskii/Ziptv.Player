import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

import ipaddr from 'ipaddr.js';

/**
 * SSRF policy for every outbound request made on behalf of a user (playlist import,
 * stream proxy, logo proxy, probes): only public unicast addresses are reachable, unless
 * the operator explicitly allows private networks (home server with a LAN TVHeadend).
 */
export class BlockedAddressError extends Error {
  readonly code = 'UPSTREAM_BLOCKED';

  constructor(readonly target: string) {
    super(`Refusing to connect to non-public address ${target}`);
    this.name = 'BlockedAddressError';
  }
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

/** Scheme + literal-IP check done before connecting (literal IPs never hit the DNS lookup hook). */
export function assertUpstreamUrlAllowed(url: URL, allowPrivateNetworks: boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError(`${url.protocol}//${url.host}`);
  }
  if (allowPrivateNetworks) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedAddressError(host);
  if (host === 'localhost' || host.endsWith('.localhost')) throw new BlockedAddressError(host);
}

/**
 * DNS lookup used by the outbound HTTP agent. Validating at *connect* time (not just before
 * the request) closes the DNS-rebinding hole where a hostname resolves to a public IP during
 * validation and to 127.0.0.1 a moment later.
 */
export function createGuardedLookup(allowPrivateNetworks: boolean): LookupFunction {
  return (hostname: string, options: LookupOptions, callback: (...args: never[]) => void) => {
    const done = callback as unknown as (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;

    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return done(error, []);
      if (!allowPrivateNetworks) {
        const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
        if (blocked) return done(new BlockedAddressError(`${hostname} (${blocked.address})`), []);
      }
      if (options.all) return done(null, addresses);
      const first = addresses[0];
      if (!first) return done(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      return done(null, first.address, first.family);
    });
  };
}
