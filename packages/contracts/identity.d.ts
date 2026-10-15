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

export type UserRole = 'user' | 'admin';

export interface MeDto {
  userId: string;
  createdAt: string;
  /** null for a guest (anonymous device identity that has not registered yet). */
  email: string | null;
  isGuest: boolean;
  role: UserRole;
}

// ---------------------------------------------------------------------------
// Accounts — email + password. A guest can register and keeps everything it has added.
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  /** 8–128 characters. */
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * The request carries a guest session that already has sources: move them into this account.
   * Without it the guest data stays with the (now unused) guest identity.
   */
  mergeGuest?: boolean;
}

/** Result of register / login. Send `token` as `Authorization: Bearer <token>`. */
export interface AuthSessionDto {
  token: string;
  /** Account sessions expire (sliding); null = does not expire. */
  expiresAt: string | null;
  user: MeDto;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface DeleteAccountRequest {
  password: string;
}

/** One signed-in device. */
export interface SessionInfoDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
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
