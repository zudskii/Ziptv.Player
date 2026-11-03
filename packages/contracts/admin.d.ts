import type { SubscriptionStatus } from './billing';
import type { FeedHealthState } from './monitoring';

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
  /** The live subscription's status (null = none). */
  subscription: SubscriptionStatus | null;
  blocked: boolean;
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
  /** Operator viewing: authorized playback sessions live now / started in the last 24 h. */
  viewers: { playingNow: number; started24h: number };
  /** Operator catalog: active channels, playable feeds by health, unresolved incidents. */
  channels: { active: number; feeds: Record<FeedHealthState, number>; openIncidents: number };
  /** Only for roles with billing:read. */
  revenue: { mrr: MoneyDto[]; activeSubscriptions: number; trialing: number; inDunning: number } | null;
  /** Four-eyes requests this staff member can see that need attention. */
  approvals: { open: number };
  generatedAt: string;
}

export interface MoneyDto {
  currency: string;
  amountMinor: number;
}

// --- four-eyes change requests (Phase 9) ---------------------------------------------------------

export type ChangeRequestKind = 'package.create' | 'package.update' | 'rights.grant' | 'rights.revoke';
export type ChangeRequestStatus = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'failed' | 'reviewed';

export interface StaffRefDto {
  id: string;
  email: string;
  name: string;
}

/**
 * A change made by two people. `approval`: waits for a second staff member, applied on approval.
 * `review`: applied at once (emergency), a second staff member reviews it afterwards.
 */
export interface ChangeRequestDto {
  id: string;
  kind: ChangeRequestKind;
  mode: 'approval' | 'review';
  status: ChangeRequestStatus;
  targetType: string;
  targetId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  requestedBy: StaffRefDto;
  requestedAt: string;
  decidedBy: StaffRefDto | null;
  decidedAt: string | null;
  decisionNote: string | null;
  error: string | null;
  /** The signed-in staff member may approve / reject / review it (never their own). */
  canDecide: boolean;
  canWithdraw: boolean;
}

export interface ChangeRequestPageDto {
  items: ChangeRequestDto[];
  total: number;
  /** Open requests this staff member can see (pending, or applied and awaiting review). */
  open: number;
}

export interface DecideChangeRequest {
  note?: string;
}

/** Answer of a change that went to four-eyes approval instead of being applied (HTTP 202). */
export interface ChangeRequestedDto {
  changeRequest: ChangeRequestDto;
}

// --- console read models (Phase 9) -------------------------------------------------------------

/** Support desk: internal notes on a subscriber (never shown to the subscriber). */
export interface SupportNoteDto {
  id: string;
  userId: string;
  userEmail: string | null;
  author: StaffRefDto;
  body: string;
  createdAt: string;
}

export interface CreateSupportNoteRequest {
  body: string;
}

export interface SecurityOverviewDto {
  staff: {
    id: string;
    email: string;
    name: string;
    role: StaffRole;
    mfaEnabled: boolean;
    disabled: boolean;
    lockedUntil: string | null;
    lastLoginAt: string | null;
    activeSessions: number;
  }[];
  failedLogins24h: number;
  /** Latest failed console sign-ins (from the audit trail). */
  recentFailures: AuditEntryDto[];
}

export interface FinanceSummaryDto {
  from: string;
  to: string;
  /** Monthly recurring revenue now: paying subscriptions (yearly plans / 12), per currency. */
  mrr: MoneyDto[];
  subscriptions: { active: number; trialing: number; pastDue: number; grace: number; endingAtPeriodEnd: number };
  period: {
    newSubscriptions: number;
    churned: number;
    activeAtStart: number;
    /** churned / activeAtStart (null when nobody was subscribed at the start). */
    churnRate: number | null;
    revenue: MoneyDto[];
    refunds: MoneyDto[];
    net: MoneyDto[];
  };
  packages: { id: string; slug: string; name: string; status: 'draft' | 'active' | 'retired'; activeSubscriptions: number; mrr: MoneyDto[]; net: MoneyDto[] }[];
  /** Calendar months (UTC) up to `to`, oldest first. */
  months: { month: string; net: MoneyDto[]; newSubscriptions: number; churned: number }[];
}

/**
 * Licensor revenue share: each package's net revenue in the period is split between providers by
 * the minutes viewers watched their feeds on that package (playback sessions).
 */
export interface PartnerReportDto {
  from: string;
  to: string;
  method: 'watch_minutes';
  totalMinutes: number;
  partners: {
    providerId: string;
    providerName: string;
    contractRef: string | null;
    minutes: number;
    share: number;
    revenue: MoneyDto[];
    monthlyCost: MoneyDto | null;
  }[];
  /** Net revenue of packages nobody watched in the period (nothing to split it by). */
  unattributedRevenue: MoneyDto[];
}

export interface ProviderReportDto {
  providerId: string;
  feeds: { total: number; healthy: number; unhealthy: number; other: number };
  /** Window of the availability figure (the probe history kept). */
  windowDays: number;
  /** Share of successful probes of the provider's feeds in the window (null = no probes). */
  availabilityPct: number | null;
  slaTargetPct: number | null;
  slaMet: boolean | null;
  openIncidents: number;
  incidentsInWindow: number;
  watchMinutesInWindow: number;
}

export interface DuplicateGroupDto {
  /** Why these look like one channel: the same normalized name or the same tvg-id alias. */
  reason: 'name' | 'tvg_id';
  key: string;
  channels: { id: string; name: string; slug: string; status: 'active' | 'hidden'; feeds: number }[];
}
