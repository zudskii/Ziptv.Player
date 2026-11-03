import type { Request } from 'express';

import type { ViewingContext } from '../../application/operator/operator.service.js';
import { isCountryCode, type DeviceClass } from '../../domain/operator/catalog.js';

/**
 * The viewer's market for licensed content: decided by the server, never by the client.
 * `header` must be one the edge (CDN / load balancer) always overwrites, e.g. Cloudflare's
 * cf-ipcountry; its special values (XX unknown, T1 Tor) are not countries and fall back to the default.
 */
export function viewingContextResolver(options: { header: string | null; defaultCountry: string | null }) {
  return (req: Request, device: DeviceClass = 'web'): ViewingContext => {
    const raw = options.header ? req.headers[options.header] : undefined;
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    const country = value && isCountryCode(value) && value !== 'XX' ? value : options.defaultCountry;
    return { country, device };
  };
}

export type ViewingContextResolver = ReturnType<typeof viewingContextResolver>;
