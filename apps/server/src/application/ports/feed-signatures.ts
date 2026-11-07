/** Verifies vendor feed signatures (Ed25519, detached over the exact body bytes). */
export interface FeedSignatures {
  /** True when `key` is a usable Ed25519 public key (base64 raw 32 bytes, or PEM/SPKI). */
  isPublicKey(key: string): boolean;
  /** True when `signature` (base64) is a valid signature of `body` by `key`. */
  verify(body: Uint8Array, signature: string, key: string): boolean;
}
