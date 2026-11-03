import { describe, expect, it } from 'vitest';

import { StaticGeoResolver } from './static-geo.js';

describe('StaticGeoResolver', () => {
  it('maps IPv4/IPv6 ranges and single addresses to countries', () => {
    const geo = new StaticGeoResolver('GE=203.0.113.0/24,2001:db8::/32; DE=198.51.100.7');
    expect(geo.countryOf('203.0.113.55')).toBe('GE');
    expect(geo.countryOf('::ffff:203.0.113.9')).toBe('GE');
    expect(geo.countryOf('2001:db8::1')).toBe('GE');
    expect(geo.countryOf('198.51.100.7')).toBe('DE');
    expect(geo.countryOf('198.51.100.8')).toBeNull();
    expect(geo.countryOf('not-an-ip')).toBeNull();
    expect(() => new StaticGeoResolver('Georgia=1.2.3.4')).toThrow();
    expect(() => new StaticGeoResolver('GE=999.1.1.1/8')).toThrow();
  });
});
