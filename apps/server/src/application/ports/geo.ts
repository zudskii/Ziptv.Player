/** IP → country (ISO 3166-1 alpha-2). A static table now; a GeoIP database later, same port. */
export interface GeoResolver {
  countryOf(ip: string): string | null;
}
