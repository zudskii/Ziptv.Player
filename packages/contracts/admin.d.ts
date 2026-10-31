// ---------------------------------------------------------------------------
// Operator console API (`/admin/v1`, served on the separate admin listener).
// Staff accounts are not subscriber accounts; every staff login needs TOTP.
// ---------------------------------------------------------------------------

export type StaffRole = 'SUPER_ADMIN' | 'CONTENT_MANAGER' | 'NOC_OPERATOR' | 'SUPPORT_AGENT' | 'FINANCE' | 'VIEW_ONLY';

export type StaffPermission =
  | 'system:read'
  | 'staff:read'
  | 'staff:write'
  | 'audit:read'
  | 'users:read'
  | 'users:write'
  | 'catalog:read'
  | 'catalog:write'
  | 'providers:read'
  | 'providers:write'
  | 'monitoring:read'
  | 'monitoring:operate'
  | 'billing:read'
  | 'billing:write'
  | 'rights:read'
  | 'rights:write'
  | 'support:read'
  | 'support:write';

export interface AdminLoginRequest {
  email: string;
  password: string;
}

/**
 * Step 1 of signing in. The password alone never yields a session:
 *  - `mfa`: enter the code from the authenticator app;
 *  - `enroll`: first sign-in — scan the secret into an authenticator app, then enter a code.
 */
export type AdminLoginResponse =
  | { step: 'mfa'; challenge: string }
  | { step: 'enroll'; challenge: string; secret: string; otpauthUri: string };

export interface AdminMfaRequest {
  challenge: string;
  code: string;
}

export interface AdminSessionDto {
  token: string;
  /** Idle expiry; every request slides it (up to the absolute limit). */
  expiresAt: string;
  me: StaffMeDto;
}

export interface StaffMeDto {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermission[];
  /** A temporary password must be replaced before anything else is allowed. */
  mustChangePassword: boolean;
}

export interface AdminChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface StaffDto {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  mfaEnabled: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreateStaffRequest {
  email: string;
  name: string;
  role: StaffRole;
}

/** The temporary password is shown once; it must be changed at first sign-in. */
export interface CreatedStaffDto {
  staff: StaffDto;
  temporaryPassword: string;
}

export interface UpdateStaffRequest {
  name?: string;
  role?: StaffRole;
  disabled?: boolean;
}

export interface AuditEntryDto {
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  hash: string;
}

export interface AuditPageDto {
  items: AuditEntryDto[];
  /** Pass as `before` to get the next (older) page; null = no more. */
  nextBefore: number | null;
}

export interface AuditVerificationDto {
  checked: number;
  intact: boolean;
  brokenAt: { seq: number; reason: string } | null;
  headHash: string | null;
}

export interface AdminUserSummaryDto {
  id: string;
  email: string | null;
  isGuest: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastSeenAt: string;
  sources: number;
  sessions: number;
}

export interface AdminUserPageDto {
  items: AdminUserSummaryDto[];
  total: number;
}

export interface AdminUserSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  userAgent: string | null;
}

export interface AdminUserDetailDto extends AdminUserSummaryDto {
  sessionsList: AdminUserSessionDto[];
  sourcesList: { id: string; name: string; type: string; status: string; lastSuccessAt: string | null }[];
}

export interface SystemOverviewDto {
  users: { total: number; registered: number; activeLast24h: number };
  sources: { total: number; failing: number; syncing: number };
  sessions: { active: number };
  staff: { total: number; withoutMfa: number };
  outbox: { pending: number; failing: number };
  generatedAt: string;
}
