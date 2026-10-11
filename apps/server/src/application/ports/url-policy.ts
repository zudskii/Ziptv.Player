/** SSRF policy check done before accepting a user-supplied URL (literal IPs, localhost, schemes). */
export interface UrlPolicy {
  /** Throws when the URL can never be fetched under the current network policy. */
  assertAllowed(url: URL): void;
}
