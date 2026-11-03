/** What a parental unlock token vouches for: the PIN was entered on this device for this profile. */
export interface UnlockClaims {
  userId: string;
  sessionId: string;
  profileId: string;
  /** PIN version at issue: changing the PIN voids every token. */
  pinVersion: number;
  /** Unix seconds. */
  expiresAt: number;
}

export interface UnlockTokens {
  issue(claims: UnlockClaims): string;
  /** The claims of a genuine, unexpired token; null otherwise. */
  verify(token: string, nowSeconds: number): UnlockClaims | null;
}
