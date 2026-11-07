/** Read models of the operator console (Phase 9): overview, finance, partners, security, support. */

export interface Money {
  currency: string;
  amountMinor: number;
}

/** A provider with the contract terms the partner report applies (Phase 17.5). */
export interface PartnerTerms {
  id: string;
  name: string;
  contractRef: string | null;
  monthlyCost: Money | null;
  /** Floor of the licensor's revenue share, per month. */
  minimumGuarantee: Money | null;
  /** Weight of a catch-up minute in the share (1 = a live minute). */
  catchupWeight: number;
  /** Separate catch-up tariff per viewing hour. */
  catchupFeePerHour: Money | null;
}

export interface SubscriptionCounts {
  active: number;
  trialing: number;
  pastDue: number;
  grace: number;
  endingAtPeriodEnd: number;
}

export interface PackageFinanceRow {
  id: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'retired';
  activeSubscriptions: number;
  mrr: Money[];
  net: Money[];
}

export interface SupportNoteRecord {
  id: string;
  userId: string;
  userEmail: string | null;
  author: { id: string; email: string; name: string };
  body: string;
  createdAt: Date;
}

export interface StaffSecurityRow {
  id: string;
  email: string;
  name: string;
  role: string;
  mfaEnabled: boolean;
  disabled: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  activeSessions: number;
}

export interface ConsoleQueries {
  viewers(now: Date): Promise<{ playingNow: number; started24h: number }>;
  activeChannels(): Promise<number>;
  /** MRR (paying subscriptions, yearly / 12) and live subscriptions by state. */
  subscriptionSnapshot(): Promise<{ mrr: Money[]; counts: SubscriptionCounts }>;
  /** Subscriptions started / ended in [from, to), those live at `from`, money in and out. */
  periodFinance(from: Date, to: Date): Promise<{ newSubscriptions: number; churned: number; activeAtStart: number; revenue: Money[]; refunds: Money[] }>;
  /** The same measures per bucket (one query per measure, not per month). */
  monthlyFinance(buckets: readonly { start: Date; end: Date }[]): Promise<{ newSubscriptions: number; churned: number; revenue: Money[]; refunds: Money[] }[]>;
  packageFinance(from: Date, to: Date): Promise<PackageFinanceRow[]>;
  /** Net revenue (paid − refunded) per package and currency in [from, to). */
  packageNet(from: Date, to: Date): Promise<{ packageId: string; currency: string; amountMinor: number }[]>;
  /** Minutes watched on package access in [from, to), per package and serving provider (null = unknown); live and catch-up apart. */
  watchMinutes(from: Date, to: Date): Promise<{ packageId: string; providerId: string | null; minutes: number; catchupMinutes: number }[]>;
  providers(): Promise<PartnerTerms[]>;
  providerReport(providerId: string, since: Date): Promise<{ feeds: { total: number; healthy: number; unhealthy: number }; probes: { ok: number; total: number }; openIncidents: number; incidents: number; minutes: number }>;
  /** Channels with counts, for grouping duplicates in the application. */
  channelsForDuplicates(): Promise<{ id: string; name: string; slug: string; status: 'active' | 'hidden'; feeds: number }[]>;
  channelStats(ids: string[]): Promise<Map<string, { feeds: number; playableFeeds: number; activeGrants: number; health: string | null }>>;
  countAudit(action: string, since: Date): Promise<number>;
  staffSecurity(now: Date): Promise<StaffSecurityRow[]>;
  supportNotes(filter: { userId?: string | undefined; limit: number }): Promise<SupportNoteRecord[]>;
  addSupportNote(note: { id: string; userId: string; authorId: string; body: string; createdAt: Date }): Promise<void>;
}
