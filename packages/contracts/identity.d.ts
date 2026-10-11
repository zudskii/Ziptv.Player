// ---------------------------------------------------------------------------
// Session (anonymous device identity — the app has no sign-up)
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  /** Secret id from the pre-2.0 client (`persist:root` in localStorage). One-time exchange. */
  legacySecretId?: string;
}

export interface SessionDto {
  /** Opaque bearer token. Send as `Authorization: Bearer <token>`. */
  token: string;
  userId: string;
  migratedFromLegacy: boolean;
}

export interface MeDto {
  userId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Profiles — every request may carry `X-Profile-Id`; without it the default profile is used.
// Favorites/My List, history, progress and parental rules are per profile.
// ---------------------------------------------------------------------------

export type ProfileKind = 'standard' | 'kids';

export interface ProfileDto {
  id: string;
  name: string;
  /** Avatar colour (hex). */
  color: string;
  kind: ProfileKind;
  isDefault: boolean;
  /** Opening this profile requires the parental PIN. */
  pinProtected: boolean;
  createdAt: string;
}

export interface CreateProfileRequest {
  name: string;
  color?: string;
  kind?: ProfileKind;
  pinProtected?: boolean;
}

export interface UpdateProfileRequest {
  name?: string;
  color?: string;
  kind?: ProfileKind;
  pinProtected?: boolean;
}

/** Selecting a PIN-protected profile requires an unlock token (see parental controls). */
export interface ProfileAccessRequest {
  pin?: string;
}

export interface ProfileAccessDto {
  profile: ProfileDto;
}
