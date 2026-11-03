import type { Request } from 'express';

import type { ViewingContext } from '../../application/operator/operator.service.js';
import type { GeoResolver } from '../../application/ports/geo.js';
import { isCountryCode, type DeviceClass } from '../../domain/operator/catalog.js';

/**
 * The viewer's market for licensed content: decided by the server, never by the client
 * (edge header, then the IP's country, then the default).
 * `header` must be one the edge (CDN / load balancer) always overwrites, e.g. Cloudflare's
 * cf-ipcountry; its special values (XX unknown, T1 Tor) are not countries and fall back to the default.
 */
export function viewingContextResolver(options: { header: string | null; defaultCountry: string | null; geo?: GeoResolver | null }) {
  return (req: Request, device: DeviceClass = 'web'): ViewingContext => {
    const raw = options.header ? req.headers[options.header] : undefined;
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    // Edge header → IP lookup (req.ip honours TRUST_PROXY) → configured default.
    const fromHeader = value && isCountryCode(value) && value !== 'XX' ? value : null;
    const country = fromHeader ?? (options.geo && req.ip ? options.geo.countryOf(req.ip) : null) ?? options.defaultCountry;
    return { country, device };
  };
}

export type ViewingContextResolver = ReturnType<typeof viewingContextResolver>;
