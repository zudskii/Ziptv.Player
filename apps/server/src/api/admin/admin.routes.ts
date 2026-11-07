import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AdminUsersService } from '../../application/admin/admin-users.service.js';
import type { AuditService } from '../../application/admin/audit.service.js';
import { toMeDto } from '../../application/admin/principal.js';
import { AppError } from '../../application/errors.js';
import type { StaffAuthService } from '../../application/admin/staff-auth.service.js';
import type { StaffService } from '../../application/admin/staff.service.js';
import type { SystemOverviewService } from '../../application/admin/system.service.js';
import type { ChangeRequestedDto } from '@ziptv/contracts';

import type { ChangeRequestService } from '../../application/admin/change-requests.service.js';
import type { ConsoleService } from '../../application/admin/console.service.js';
import type { OperatorEpgService } from '../../application/operator/operator-epg.service.js';
import type { CommerceAdminService } from '../../application/commerce/commerce-admin.service.js';
import type { MonitoringAdminService } from '../../application/health/monitoring-admin.service.js';
import type { CatalogAdminService } from '../../application/operator/catalog-admin.service.js';
import { STAFF_ROLES } from '../../domain/admin/rbac.js';
import { FEED_HEALTH_STATES } from '../../domain/health/feed-health.js';
import { BUSINESS_MODELS, DEVICE_CLASSES, PROVIDER_TYPES } from '../../domain/operator/catalog.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from '../routes/schemas.js';
import { adminContext, AdminRouter, currentStaff } from './admin-router.js';

export interface AdminServices {
  auth: StaffAuthService;
  staff: StaffService;
  audit: AuditService;
  users: AdminUsersService;
  system: SystemOverviewService;
  catalog: CatalogAdminService;
  monitoring: MonitoringAdminService;
  commerce: CommerceAdminService;
  changes: ChangeRequestService;
  console: ConsoleService;
  epg: OperatorEpgService;
}

const Email = z.string().trim().email().max(254);
const Role = z.enum(STAFF_ROLES);
const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) }).strict();
const MfaBody = z.object({ challenge: z.string().min(10).max(2048), code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits') }).strict();
const PasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }).strict();
const CreateStaffBody = z.object({ email: Email, name: z.string().trim().min(1).max(100), role: Role }).strict();
const UpdateStaffBody = z
  .object({ name: z.string().trim().min(1).max(100).optional(), role: Role.optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const AuditQuery = z.object({
  actorId: EntityId.optional(),
  action: z.string().max(80).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(80).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const UsersQuery = z.object({ q: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) });

// --- operator catalog ----------------------------------------------------------------------------
const Name = z.string().trim().min(1).max(120);
const Slug = z.string().trim().min(1).max(80);
const Page = { offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) };
const Country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code');
const HttpUrl = z.string().trim().url().max(2048).refine((value) => /^https?:\/\//i.test(value), 'must be http(s)');
const Credential = z.union([
  z.object({ secretRef: z.string().trim().max(120) }).strict(),
  z.object({ connection: z.record(z.string().max(40), z.string().max(2048)).refine((value) => Object.keys(value).length <= 8, 'too many fields') }).strict(),
]);
// Mock (development) channels; `catchup` = the stream's archive, M3U conventions.
const MockCatchup = z.object({ mode: z.enum(['default', 'append', 'shift', 'flussonic']), days: z.number().int().min(1).max(30), template: z.string().max(2_000).optional() }).strict();
const MockChannel = z.object({ id: z.string().min(1).max(120), name: Name, url: HttpUrl, tvgId: z.string().max(200).optional(), group: z.string().max(120).optional(), logo: HttpUrl.optional(), kind: z.enum(['hls', 'dash', 'mpegts', 'flv', 'progressive']).optional(), catchup: MockCatchup.optional() }).strict();
// Vendor feeds: the Ed25519 public keys the vendor signs its feed with (key rotation = several ids).
const FeedPublicKey = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/), key: z.string().trim().min(40).max(600) }).strict();
const ProviderConfig = z.object({ channels: z.array(MockChannel).max(5_000).optional(), publicKeys: z.array(FeedPublicKey).min(1).max(5).optional(), notes: z.string().max(2_000).optional() }).strict();
const SyncHours = z.number().int().min(1).max(168);
const EventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const CreateProviderBody = z.object({ name: Name, slug: Slug.optional(), type: z.enum(PROVIDER_TYPES), credential: Credential.optional(), config: ProviderConfig.optional(), syncIntervalHours: SyncHours.optional() }).strict();
const UpdateProviderBody = z
  .object({
    name: Name.optional(),
    status: z.enum(['active', 'paused', 'terminated']).optional(),
    config: ProviderConfig.optional(),
    syncIntervalHours: SyncHours.optional(),
    contract: z
      .object({
        ref: z.string().trim().max(200).nullable().optional(),
        startAt: z.string().datetime({ offset: true }).nullable().optional(),
        endAt: z.string().datetime({ offset: true }).nullable().optional(),
        slaTargetPct: z.number().gt(0).max(100).nullable().optional(),
        monthlyCost: z.object({ currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code'), amountMinor: z.number().int().min(0).max(1_000_000_000) }).strict().nullable().optional(),
        notes: z.string().max(4000).optional(),
        minimumGuarantee: z.object({ currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code'), amountMinor: z.number().int().min(0).max(1_000_000_000) }).strict().nullable().optional(),
        catchupWeight: z.number().min(0).max(5).optional(),
        catchupFeePerHour: z.object({ currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code'), amountMinor: z.number().int().min(0).max(100_000_000) }).strict().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const StreamsQuery = z.object({ providerId: EntityId.optional(), status: z.enum(['pending', 'matched', 'ignored', 'gone']).default('pending'), ...Page });
const Languages = z.array(z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/, 'must be ISO 639 codes')).max(10);
const ReviewBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), channelId: EntityId }).strict(),
  z.object({ action: z.literal('create'), name: Name.optional(), originCountry: Country.nullable().optional(), languages: Languages.optional(), categoryId: EntityId.nullable().optional() }).strict(),
  z.object({ action: z.literal('ignore') }).strict(),
]);
const CategoryBody = z.object({ name: Name, slug: Slug.optional() }).strict();
const ChannelsQuery = z.object({ q: z.string().max(200).optional(), status: z.enum(['active', 'hidden']).optional(), ...Page });
const ChannelFields = {
  name: Name,
  slug: Slug.optional(),
  originCountry: Country.nullable().optional(),
  languages: Languages.optional(),
  categoryId: EntityId.nullable().optional(),
  logo: HttpUrl.nullable().optional(),
  globalUid: z.string().trim().min(1).max(200).nullable().optional(),
};
const CreateChannelBody = z.object(ChannelFields).strict();
const UpdateChannelBody = z
  .object({ ...ChannelFields, name: Name.optional(), status: z.enum(['active', 'hidden']).optional(), aliases: z.array(Name).max(20).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const MergeBody = z.object({ fromChannelId: EntityId }).strict();
const UpdateFeedBody = z
  .object({ priority: z.number().int().min(0).max(1_000_000).optional(), status: z.enum(['active', 'disabled']).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const GrantBody = z
  .object({
    territory: z.union([z.literal('*'), Country]),
    deviceClasses: z.array(z.enum(DEVICE_CLASSES)).min(1),
    businessModels: z.array(z.enum(BUSINESS_MODELS)).min(1),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable().optional(),
    contractRef: z.string().trim().min(1).max(200),
    /** Catch-up rights (days back; 0/absent = live only). */
    catchupDays: z.number().int().min(0).max(30).optional(),
    maxQuality: z.enum(['sd', 'hd', 'fhd', 'uhd']).nullable().optional(),
  })
  .strict();
const CreateLineupBody = z.object({ name: Name, slug: Slug.optional(), country: Country, status: z.enum(['draft', 'active']).optional() }).strict();
const UpdateLineupBody = z
  .object({ name: Name.optional(), status: z.enum(['draft', 'active']).optional(), entries: z.array(z.object({ channelId: EntityId, number: z.number().int().min(1).max(99_999) }).strict()).max(5_000).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const LineupRef = z.string().trim().min(1).max(80);

// --- commerce ----------------------------------------------------------------------------------
const PackageFields = {
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, dashes').optional(),
  description: z.string().trim().max(1000).optional(),
  priceMinor: z.number().int().min(0).max(100_000_00),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code'),
  billingPeriod: z.enum(['month', 'year']),
  trialDays: z.number().int().min(0).max(90).optional(),
  maxDevices: z.number().int().min(1).max(50),
  maxStreams: z.number().int().min(1).max(20),
  businessModel: z.enum(['subscription', 'b2b']).optional(),
  vodMode: z.enum(['included', 'package', 'none']).optional(),
  vodPackages: z.array(EntityId).max(200).optional(),
  maxQuality: z.enum(['sd', 'hd', 'fhd', 'uhd']).nullable().optional(),
  catchupDays: z.number().int().min(0).max(30).nullable().optional(),
  prices: z
    .array(z.object({ country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO 3166 code'), currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code'), priceMinor: z.number().int().min(0).max(100_000_00) }).strict())
    .max(250)
    .optional(),
};
const CreatePackageBody = z.object(PackageFields).strict();
const UpdatePackageBody = z
  .object({ ...PackageFields, status: z.enum(['draft', 'active', 'retired']), channelIds: z.array(EntityId).max(5000) })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const PromoCodeText = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, dashes, underscores');
const CreatePromoBody = z
  .object({
    code: PromoCodeText,
    kind: z.enum(['percent', 'amount']),
    value: z.number().int().min(1).max(100_000_00),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional(),
    families: z.array(EntityId).max(100).optional(),
    maxRedemptions: z.number().int().min(1).max(10_000_000).nullable().optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const UpdatePromoBody = z
  .object({ active: z.literal(false).optional(), note: z.string().trim().max(500).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const CompBody = z.object({ packageId: EntityId, endsAt: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().trim().min(3).max(500) }).strict();
const BlockBody = z.object({ blocked: z.boolean(), reason: z.string().trim().max(500).optional() }).strict();
const PaymentEventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

const ChangeRequestsQuery = z.object({
  status: z.enum(['open', 'pending', 'applied', 'rejected', 'withdrawn', 'failed', 'reviewed']).optional(),
  kind: z.enum(['package.create', 'package.update', 'rights.grant', 'rights.revoke', 'promo.create']).optional(),
  targetId: EntityId.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const GuideUrl = z.string().trim().url().max(2048);
const CreateGuideBody = z.object({ name: z.string().trim().min(1).max(100), url: GuideUrl, priority: z.number().int().min(0).max(1000).optional(), syncIntervalHours: z.number().int().min(1).max(168).optional() }).strict();
const UpdateGuideBody = z
  .object({ name: z.string().trim().min(1).max(100).optional(), url: GuideUrl.optional(), status: z.enum(['active', 'paused']).optional(), priority: z.number().int().min(0).max(1000).optional(), syncIntervalHours: z.number().int().min(1).max(168).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const GuideChannelsQuery = z.object({ q: z.string().max(100).optional(), guideId: EntityId.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const MappingBody = z.object({ guideId: EntityId, epgChannelId: z.string().trim().min(1).max(300) }).strict();
const RangeQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const NotesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const NoteBody = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const DecisionBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();

// --- monitoring -----------------------------------------------------------------------------------
const FeedHealthQuery = z.object({ status: z.enum(FEED_HEALTH_STATES).optional(), channelId: EntityId.optional(), providerId: EntityId.optional(), ...Page });
const ProbesQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const MaintenanceBody = z.object({ on: z.boolean(), note: z.string().trim().max(300).optional() }).strict();
const PinBody = z.object({ feedId: EntityId, until: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(300).optional() }).strict();
const IncidentsQuery = z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'live']).optional(), ...Page });

const digest = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 22);

/** `/admin/v1` — every route declares its access; see AdminRouter. */
export function createAdminRoutes(services: AdminServices, limit: RateLimiterFactory): AdminRouter {
  const r = new AdminRouter(services.auth);
  const loginIp = limit({ name: 'admin:login-ip', windowMs: 10 * 60_000, limit: 10, skipSuccessful: true });
  // Successful password steps count too: a known password must not mint unlimited MFA challenges.
  const loginEmail = limit({ name: 'admin:login-email', windowMs: 15 * 60_000, limit: 10, key: (req) => (typeof req.body?.email === 'string' ? `email:${digest(req.body.email.trim().toLowerCase())}` : undefined) });
  const mfa = limit({ name: 'admin:mfa', windowMs: 5 * 60_000, limit: 5, skipSuccessful: true, key: (req) => (typeof req.body?.challenge === 'string' ? `challenge:${digest(req.body.challenge)}` : undefined) });
  const mfaIp = limit({ name: 'admin:mfa-ip', windowMs: 10 * 60_000, limit: 20, skipSuccessful: true });

  // --- sign-in -------------------------------------------------------------------------------
  r.post('/auth/login', 'public', loginIp, loginEmail, async (req, res) => {
    res.json(await services.auth.login(parseInput(LoginBody, req.body, 'Sign-in'), adminContext(req)));
  });
  r.post('/auth/mfa', 'public', mfaIp, mfa, async (req, res) => {
    res.json(await services.auth.verifyMfa(parseInput(MfaBody, req.body, 'Code'), adminContext(req)));
  });
  r.get('/me', 'session', (req, res) => {
    res.json(toMeDto(currentStaff(req)));
  });
  r.post('/auth/logout', 'session', async (req, res) => {
    await services.auth.logout(currentStaff(req), adminContext(req));
    res.status(204).end();
  });
  r.post('/auth/password', 'session', async (req, res) => {
    await services.auth.changePassword(currentStaff(req), parseInput(PasswordBody, req.body, 'Password change'), adminContext(req));
    res.status(204).end();
  });

  // --- overview ------------------------------------------------------------------------------
  r.get('/system/overview', 'system:read', async (req, res) => {
    res.json(await services.system.overview(currentStaff(req)));
  });

  // --- staff -----------------------------------------------------------------------------------
  r.get('/staff', 'staff:read', async (_req, res) => {
    res.json(await services.staff.list());
  });
  r.post('/staff', 'staff:write', async (req, res) => {
    res.status(201).json(await services.staff.create(currentStaff(req), parseInput(CreateStaffBody, req.body, 'Staff member'), adminContext(req)));
  });
  r.patch('/staff/:id', 'staff:write', async (req, res) => {
    const id = parseInput(EntityId, routeParam(req, 'id'), 'Staff id');
    res.json(await services.staff.update(currentStaff(req), id, parseInput(UpdateStaffBody, req.body, 'Staff change'), adminContext(req)));
  });
  r.post('/staff/:id/reset-mfa', 'staff:write', async (req, res) => {
    res.json(await services.staff.resetMfa(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'Staff id'), adminContext(req)));
  });
  r.post('/staff/:id/reset-password', 'staff:write', async (req, res) => {
    res.json(await services.staff.resetPassword(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'Staff id'), adminContext(req)));
  });

  // --- audit -----------------------------------------------------------------------------------
  r.get('/audit', 'audit:read', async (req, res) => {
    res.json(await services.audit.list(parseInput(AuditQuery, req.query, 'Audit filter')));
  });
  r.get('/audit/verify', 'audit:read', async (_req, res) => {
    res.json(await services.audit.verify());
  });

  // --- subscribers -------------------------------------------------------------------------------
  r.get('/users', 'users:read', async (req, res) => {
    const query = parseInput(UsersQuery, req.query, 'User search');
    res.json(await services.users.search({ text: query.q, offset: query.offset, limit: query.limit }));
  });
  r.get('/users/:id', 'users:read', async (req, res) => {
    res.json(await services.users.get(parseInput(EntityId, routeParam(req, 'id'), 'User id')));
  });
  r.post('/users/:id/revoke-sessions', 'users:write', async (req, res) => {
    res.json(await services.users.revokeSessions(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'User id'), adminContext(req)));
  });

  // --- operator catalog: providers -------------------------------------------------------------
  const catalog = services.catalog;
  const id = (req: Parameters<typeof routeParam>[0], label: string) => parseInput(EntityId, routeParam(req, 'id'), label);
  r.get('/providers', 'providers:read', async (_req, res) => {
    res.json(await catalog.providers());
  });
  r.post('/providers', 'providers:write', async (req, res) => {
    res.status(201).json(await catalog.createProvider(currentStaff(req), parseInput(CreateProviderBody, req.body, 'Provider'), adminContext(req)));
  });
  r.patch('/providers/:id', 'providers:write', async (req, res) => {
    res.json(await catalog.updateProvider(currentStaff(req), id(req, 'Provider id'), parseInput(UpdateProviderBody, req.body, 'Provider change'), adminContext(req)));
  });
  r.post('/providers/:id/credential', 'providers:write', async (req, res) => {
    res.json(await catalog.rotateCredential(currentStaff(req), id(req, 'Provider id'), parseInput(Credential, req.body, 'Credential'), adminContext(req)));
  });
  r.post('/providers/:id/sync', 'providers:write', async (req, res) => {
    res.status(202).json(await catalog.requestSync(currentStaff(req), id(req, 'Provider id'), adminContext(req)));
  });
  r.get('/providers/:id/health', 'providers:read', async (req, res) => {
    res.json(await catalog.health(id(req, 'Provider id')));
  });
  r.get('/providers/:id/events', 'providers:read', async (req, res) => {
    const { limit } = parseInput(EventsQuery, req.query, 'Journal filter');
    res.json(await catalog.events(id(req, 'Provider id'), limit));
  });
  r.get('/providers/:id/conflicts', 'providers:read', async (req, res) => {
    res.json(await catalog.conflicts(id(req, 'Provider id')));
  });
  r.get('/providers/:id/content', 'providers:read', async (req, res) => {
    res.json(await catalog.content(id(req, 'Provider id')));
  });

  // --- ingestion review ------------------------------------------------------------------------
  r.get('/streams', 'catalog:read', async (req, res) => {
    res.json(await catalog.reviewQueue(parseInput(StreamsQuery, req.query, 'Stream filter')));
  });
  r.post('/streams/:id/review', 'catalog:write', async (req, res) => {
    res.json(await catalog.review(currentStaff(req), id(req, 'Stream id'), parseInput(ReviewBody, req.body, 'Review decision'), adminContext(req)));
  });

  // --- categories & channels -------------------------------------------------------------------
  r.get('/categories', 'catalog:read', async (_req, res) => {
    res.json(await catalog.categories());
  });
  r.post('/categories', 'catalog:write', async (req, res) => {
    res.status(201).json(await catalog.createCategory(currentStaff(req), parseInput(CategoryBody, req.body, 'Category'), adminContext(req)));
  });
  r.get('/channels', 'catalog:read', async (req, res) => {
    const query = parseInput(ChannelsQuery, req.query, 'Channel search');
    res.json(await catalog.channels({ text: query.q, status: query.status, offset: query.offset, limit: query.limit }));
  });
  r.post('/channels', 'catalog:write', async (req, res) => {
    res.status(201).json(await catalog.createChannel(currentStaff(req), parseInput(CreateChannelBody, req.body, 'Channel'), adminContext(req)));
  });
  r.get('/channels/duplicates', 'catalog:read', async (_req, res) => {
    res.json(await services.console.duplicates());
  });
  r.get('/channels/:id', 'catalog:read', async (req, res) => {
    res.json(await catalog.channel(id(req, 'Channel id')));
  });
  r.patch('/channels/:id', 'catalog:write', async (req, res) => {
    res.json(await catalog.updateChannel(currentStaff(req), id(req, 'Channel id'), parseInput(UpdateChannelBody, req.body, 'Channel change'), adminContext(req)));
  });
  r.post('/channels/:id/merge', 'catalog:write', async (req, res) => {
    const body = parseInput(MergeBody, req.body, 'Merge');
    res.json(await catalog.mergeChannels(currentStaff(req), id(req, 'Channel id'), body.fromChannelId, adminContext(req)));
  });

  // --- feeds -----------------------------------------------------------------------------------
  r.patch('/feeds/:id', 'catalog:write', async (req, res) => {
    res.json(await catalog.updateFeed(currentStaff(req), id(req, 'Feed id'), parseInput(UpdateFeedBody, req.body, 'Feed change'), adminContext(req)));
  });
  r.delete('/feeds/:id', 'catalog:write', async (req, res) => {
    await catalog.deleteFeed(currentStaff(req), id(req, 'Feed id'), adminContext(req));
    res.status(204).end();
  });

  // --- rights ----------------------------------------------------------------------------------
  r.post('/channels/:id/grants', 'rights:write', async (req, res) => {
    const outcome = await catalog.grant(currentStaff(req), id(req, 'Channel id'), parseInput(GrantBody, req.body, 'Rights grant'), adminContext(req));
    // 201 + the grant when applied (four-eyes off); 202 + the change request waiting for approval.
    if (outcome.status === 'applied') res.status(201).json(outcome.grant);
    else res.status(202).json({ changeRequest: outcome.request } satisfies ChangeRequestedDto);
  });
  r.post('/grants/:id/revoke', 'rights:write', async (req, res) => {
    res.json(await catalog.revokeGrant(currentStaff(req), id(req, 'Grant id'), adminContext(req)));
  });

  // --- lineups ---------------------------------------------------------------------------------
  r.get('/lineups', 'catalog:read', async (_req, res) => {
    res.json(await catalog.lineups());
  });
  r.post('/lineups', 'catalog:write', async (req, res) => {
    res.status(201).json(await catalog.createLineup(currentStaff(req), parseInput(CreateLineupBody, req.body, 'Lineup'), adminContext(req)));
  });
  r.get('/lineups/:id', 'catalog:read', async (req, res) => {
    res.json(await catalog.lineup(parseInput(LineupRef, routeParam(req, 'id'), 'Lineup')));
  });
  r.patch('/lineups/:id', 'catalog:write', async (req, res) => {
    res.json(await catalog.updateLineup(currentStaff(req), id(req, 'Lineup id'), parseInput(UpdateLineupBody, req.body, 'Lineup change'), adminContext(req)));
  });

  // --- monitoring: health, failover, incidents ----------------------------------------------------
  const monitoring = services.monitoring;
  r.get('/monitoring/feeds', 'monitoring:read', async (req, res) => {
    res.json(await monitoring.feeds(parseInput(FeedHealthQuery, req.query, 'Feed filter')));
  });
  r.get('/monitoring/feeds/:id/probes', 'monitoring:read', async (req, res) => {
    res.json(await monitoring.probes(id(req, 'Feed id'), parseInput(ProbesQuery, req.query, 'Probe history').limit));
  });
  r.post('/monitoring/feeds/:id/probe', 'monitoring:operate', async (req, res) => {
    await monitoring.probeNow(currentStaff(req), id(req, 'Feed id'), adminContext(req));
    res.status(202).end();
  });
  r.post('/monitoring/feeds/:id/maintenance', 'monitoring:operate', async (req, res) => {
    res.json(await monitoring.maintenance(currentStaff(req), id(req, 'Feed id'), parseInput(MaintenanceBody, req.body, 'Maintenance'), adminContext(req)));
  });
  r.get('/monitoring/channels/:id/failover', 'monitoring:read', async (req, res) => {
    res.json(await monitoring.failover(id(req, 'Channel id')));
  });
  r.post('/monitoring/channels/:id/failover/pin', 'monitoring:operate', async (req, res) => {
    res.json(await monitoring.pin(currentStaff(req), id(req, 'Channel id'), parseInput(PinBody, req.body, 'Pin'), adminContext(req)));
  });
  r.delete('/monitoring/channels/:id/failover/pin', 'monitoring:operate', async (req, res) => {
    res.json(await monitoring.unpin(currentStaff(req), id(req, 'Channel id'), adminContext(req)));
  });
  r.get('/monitoring/incidents', 'monitoring:read', async (req, res) => {
    res.json(await monitoring.incidents(parseInput(IncidentsQuery, req.query, 'Incident filter')));
  });
  r.post('/monitoring/incidents/:id/acknowledge', 'monitoring:operate', async (req, res) => {
    res.json(await monitoring.acknowledge(currentStaff(req), id(req, 'Incident id'), adminContext(req)));
  });
  r.post('/monitoring/incidents/:id/resolve', 'monitoring:operate', async (req, res) => {
    res.json(await monitoring.resolve(currentStaff(req), id(req, 'Incident id'), adminContext(req)));
  });

  // --- commerce: packages, subscribers, payments -------------------------------------------------
  const commerce = services.commerce;
  r.get('/packages', 'billing:read', async (_req, res) => {
    res.json(await commerce.packages());
  });
  r.post('/packages', 'billing:write', async (req, res) => {
    const outcome = await commerce.createPackage(currentStaff(req), parseInput(CreatePackageBody, req.body, 'Package'), adminContext(req));
    if (outcome.status === 'applied') res.status(201).json(outcome.package);
    else res.status(202).json({ changeRequest: outcome.request } satisfies ChangeRequestedDto);
  });
  r.get('/packages/:id', 'billing:read', async (req, res) => {
    res.json(await commerce.package(id(req, 'Package id')));
  });
  r.patch('/packages/:id', 'billing:write', async (req, res) => {
    const outcome = await commerce.updatePackage(currentStaff(req), id(req, 'Package id'), parseInput(UpdatePackageBody, req.body, 'Package change'), adminContext(req));
    if (outcome.status === 'applied') res.json(outcome.package);
    else res.status(202).json({ changeRequest: outcome.request } satisfies ChangeRequestedDto);
  });
  r.get('/provider-packages', 'billing:read', async (_req, res) => {
    res.json(await commerce.providerPackages());
  });
  r.get('/promo-codes', 'billing:read', async (_req, res) => {
    res.json(await commerce.promos());
  });
  r.post('/promo-codes', 'billing:write', async (req, res) => {
    const outcome = await commerce.createPromo(currentStaff(req), parseInput(CreatePromoBody, req.body, 'Promo code'), adminContext(req));
    if (outcome.status === 'applied') res.status(201).json(outcome.promo);
    else res.status(202).json({ changeRequest: outcome.request } satisfies ChangeRequestedDto);
  });
  r.patch('/promo-codes/:id', 'billing:write', async (req, res) => {
    res.json(await commerce.updatePromo(currentStaff(req), id(req, 'Promo code id'), parseInput(UpdatePromoBody, req.body, 'Promo code change'), adminContext(req)));
  });
  r.get('/users/:id/billing', 'billing:read', async (req, res) => {
    res.json(await commerce.userBilling(id(req, 'User id')));
  });
  r.post('/users/:id/entitlements', 'billing:write', async (req, res) => {
    res.status(201).json(await commerce.grantComp(currentStaff(req), id(req, 'User id'), parseInput(CompBody, req.body, 'Comp entitlement'), adminContext(req)));
  });
  r.delete('/users/:id/entitlements/:entitlementId', 'billing:write', async (req, res) => {
    await commerce.revokeEntitlement(currentStaff(req), id(req, 'User id'), parseInput(EntityId, routeParam(req, 'entitlementId'), 'Entitlement id'), adminContext(req));
    res.status(204).end();
  });
  r.post('/users/:id/subscription/refund', 'billing:write', async (req, res) => {
    await commerce.refund(currentStaff(req), id(req, 'User id'), adminContext(req));
    res.status(202).json({ status: 'requested' });
  });
  r.post('/users/:id/subscription/cancel', 'billing:write', async (req, res) => {
    await commerce.cancelNow(currentStaff(req), id(req, 'User id'), adminContext(req));
    res.status(202).json({ status: 'requested' });
  });
  r.post('/users/:id/block', 'users:write', async (req, res) => {
    res.json(await commerce.setBlocked(currentStaff(req), id(req, 'User id'), parseInput(BlockBody, req.body, 'Block'), adminContext(req)));
  });
  r.get('/billing/payment-events', 'billing:read', async (req, res) => {
    res.json(await commerce.paymentEvents(parseInput(PaymentEventsQuery, req.query, 'Payment events').limit));
  });

  // --- operator EPG (9.7) ---------------------------------------------------------------------------
  const epg = services.epg;
  r.get('/epg/guides', 'catalog:read', async (_req, res) => {
    res.json(await epg.guides());
  });
  r.post('/epg/guides', 'catalog:write', async (req, res) => {
    res.status(201).json(await epg.createGuide(currentStaff(req), parseInput(CreateGuideBody, req.body, 'Guide'), adminContext(req)));
  });
  r.patch('/epg/guides/:id', 'catalog:write', async (req, res) => {
    res.json(await epg.updateGuide(currentStaff(req), id(req, 'Guide id'), parseInput(UpdateGuideBody, req.body, 'Guide change'), adminContext(req)));
  });
  r.delete('/epg/guides/:id', 'catalog:write', async (req, res) => {
    await epg.deleteGuide(currentStaff(req), id(req, 'Guide id'), adminContext(req));
    res.status(204).end();
  });
  r.post('/epg/guides/:id/sync', 'catalog:write', async (req, res) => {
    await epg.syncNow(currentStaff(req), id(req, 'Guide id'), adminContext(req));
    res.status(202).json({ status: 'queued' });
  });
  r.get('/epg/coverage', 'catalog:read', async (_req, res) => {
    res.json(await epg.coverage());
  });
  r.get('/epg/guide-channels', 'catalog:read', async (req, res) => {
    const query = parseInput(GuideChannelsQuery, req.query, 'Guide channel search');
    res.json(await epg.searchGuideChannels({ guideId: query.guideId, text: query.q ?? '', limit: query.limit }));
  });
  r.post('/channels/:id/epg', 'catalog:write', async (req, res) => {
    await epg.setMapping(currentStaff(req), id(req, 'Channel id'), parseInput(MappingBody, req.body, 'EPG mapping'), adminContext(req));
    res.status(204).end();
  });
  r.delete('/channels/:id/epg', 'catalog:write', async (req, res) => {
    await epg.clearMapping(currentStaff(req), id(req, 'Channel id'), adminContext(req));
    res.status(204).end();
  });

  // --- console read models: finance, partners, providers, security, support ----------------------
  const reports = services.console;
  r.get('/finance/summary', 'billing:read', async (req, res) => {
    res.json(await reports.finance(parseInput(RangeQuery, req.query, 'Report period')));
  });
  r.get('/finance/partners', 'billing:read', async (req, res) => {
    res.json(await reports.partners(parseInput(RangeQuery, req.query, 'Report period')));
  });
  r.get('/finance/partners.csv', 'billing:read', async (req, res) => {
    const csv = await reports.partnersCsv(parseInput(RangeQuery, req.query, 'Report period'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ziptv-partners.csv"');
    res.send(csv);
  });
  r.get('/providers/:id/report', 'providers:read', async (req, res) => {
    const provider = (await services.catalog.providers()).find((item) => item.id === id(req, 'Provider id'));
    if (!provider) throw AppError.notFound('Provider');
    res.json(await reports.providerReport(provider.id, provider.contract.slaTargetPct));
  });
  r.get('/security/overview', 'audit:read', async (req, res) => {
    res.json(await reports.security(currentStaff(req)));
  });
  r.get('/support/notes', 'support:read', async (req, res) => {
    res.json(await reports.notes({ limit: parseInput(NotesQuery, req.query, 'Notes').limit }));
  });
  r.get('/users/:id/notes', 'support:read', async (req, res) => {
    res.json(await reports.notes({ userId: id(req, 'User id'), limit: parseInput(NotesQuery, req.query, 'Notes').limit }));
  });
  r.post('/users/:id/notes', 'support:write', async (req, res) => {
    res.status(201).json(await reports.addNote(currentStaff(req), id(req, 'User id'), parseInput(NoteBody, req.body, 'Note').body, adminContext(req)));
  });

  // --- four-eyes change requests ------------------------------------------------------------------
  // Listed and decided per kind: the service checks the role's permission for each kind and never
  // lets the requester decide on their own request.
  const changes = services.changes;
  r.get('/change-requests', 'system:read', async (req, res) => {
    res.json(await changes.list(currentStaff(req), parseInput(ChangeRequestsQuery, req.query, 'Change request filter')));
  });
  r.get('/change-requests/:id', 'system:read', async (req, res) => {
    res.json(await changes.get(currentStaff(req), id(req, 'Change request id')));
  });
  for (const decision of ['approve', 'reject', 'withdraw', 'review'] as const) {
    r.post(`/change-requests/:id/${decision}`, 'system:read', async (req, res) => {
      const body = parseInput(DecisionBody, req.body ?? {}, 'Decision');
      res.json(await changes.decide(currentStaff(req), id(req, 'Change request id'), decision, body.note ?? null, adminContext(req)));
    });
  }

  return r;
}
