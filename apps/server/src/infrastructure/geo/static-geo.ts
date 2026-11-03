import { BlockList, isIP } from 'node:net';

import type { GeoResolver } from '../../application/ports/geo.js';

/**
 * Country by IP from a configured table (`GEO_STATIC_RANGES="GE=203.0.113.0/24,2001:db8::/32;DE=198.51.100.0/24"`).
 * Good for fixed networks (offices, test labs, a B2B customer's egress) and tests; replace with a
 * GeoIP database adapter for the public internet.
 */
export class StaticGeoResolver implements GeoResolver {
  private readonly tables: { country: string; ranges: BlockList }[] = [];

  constructor(spec: string) {
    for (const entry of spec.split(';').map((part) => part.trim()).filter(Boolean)) {
      const [country, list] = entry.split('=');
      if (!country || !list || !/^[A-Z]{2}$/.test(country.trim())) throw new Error(`GEO_STATIC_RANGES: bad entry "${entry}"`);
      const ranges = new BlockList();
      for (const cidr of list.split(',').map((part) => part.trim()).filter(Boolean)) {
        const [address, bits] = cidr.split('/');
        const family = isIP(address ?? '');
        if (!family) throw new Error(`GEO_STATIC_RANGES: bad address "${cidr}"`);
        const type = family === 6 ? 'ipv6' : 'ipv4';
        if (bits === undefined) ranges.addAddress(address!, type);
        else ranges.addSubnet(address!, Number(bits), type);
      }
      this.tables.push({ country: country.trim(), ranges });
    }
  }

  countryOf(ip: string): string | null {
    // Express reports IPv4 clients of a dual-stack socket as ::ffff:a.b.c.d.
    const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    const family = isIP(address);
    if (!family) return null;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    return this.tables.find((table) => table.ranges.check(address, type))?.country ?? null;
  }
}
