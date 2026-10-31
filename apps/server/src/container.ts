import type { RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';

import { AdminUsersService, USER_SESSIONS_REVOKED } from './application/admin/admin-users.service.js';
import { AuditService } from './application/admin/audit.service.js';
import { StaffAuthService } from './application/admin/staff-auth.service.js';
import { StaffService } from './application/admin/staff.service.js';
import { SystemOverviewService } from './application/admin/system.service.js';
import { createOutboxWorker } from './application/outbox/outbox-dispatcher.js';
import type { SecretStore } from './application/ports/secret-store.js';
import { directArtwork, proxiedArtwork } from './application/catalog/artwork.js';
import { SeriesEpisodes } from './application/catalog/series-episodes.js';
import { VodCatalogService } from './application/catalog/vod.service.js';
import { CatalogImages } from './application/catalog/catalog-images.js';
import { LiveCatalogService } from './application/catalog/live.service.js';
import { AccountService } from './application/identity/account.service.js';
import { EmailFlowService } from './application/identity/email-flow.service.js';
import { PlaylistEntryService, PlaylistRelinker } from './application/playlists/playlist-entry.service.js';
import { PlaylistExportService } from './application/playlists/playlist-export.service.js';
import { PlaylistService } from './application/playlists/playlist.service.js';
import { SessionService } from './application/identity/session.service.js';
import { accountViewerResolver, type ViewerResolver } from './application/identity/viewer-resolver.js';
import { JobRunner, periodicWorker } from './application/jobs/job-runner.js';
import { NotificationService } from './application/notifications/notification.service.js';
import { MediaGrantChecker } from './application/playback/media-grants.js';
import { PlaybackService } from './application/playback/playback.service.js';
import { ProviderStreamUrls } from './application/playback/provider-stream-urls.js';
import type { LeaseStore } from './application/ports/lease-store.js';
import type { Cache } from './application/ports/cache.js';
import { systemClock, type Clock } from './application/ports/clock.js';
import type { Logger } from './application/ports/logger.js';
import type { Mailer } from './application/ports/mailer.js';
import type { PasswordHasher } from './application/ports/password-hasher.js';
import { SourceEpgLinker } from './application/epg/epg-linker.js';
import { createEpgSyncWorker, EpgSyncPipeline } from './application/epg/epg-sync.pipeline.js';
import { EpgService } from './application/epg/epg.service.js';
import { SourceSecrets } from './application/sources/secrets.js';
import { SourceService } from './application/sources/source.service.js';
import { SourceSyncPipeline } from './application/sources/source-sync.pipeline.js';
import { createSourceSyncWorker } from './application/sources/source-sync.worker.js';
import type { AppConfig } from './config/env.js';
import { MEDIA_PREFIX } from './api/http-paths.js';
import { CoherentCache } from './infrastructure/cache/coherent-cache.js';
import { MemoryCache } from './infrastructure/cache/memory-cache.js';
import { MemoryLeaseStore } from './infrastructure/cache/memory-lease-store.js';
import { createRedis, RedisInvalidationBus, RedisLeaseStore, redisRateLimitStores } from './infrastructure/redis/redis.js';
import { MediaTokenCodec } from './infrastructure/crypto/media-token.js';
import { M3uFormatter } from './infrastructure/formats/m3u-formatter.js';
import { LogMailer } from './infrastructure/mail/log-mailer.js';
import { SmtpMailer } from './infrastructure/mail/smtp-mailer.js';
import { ScryptPasswordHasher } from './infrastructure/crypto/password-hasher.js';
import { AesSecretCipher, parseEncryptionKey } from './infrastructure/crypto/secret-cipher.js';
import { assertUpstreamUrlAllowed } from './infrastructure/http/network-policy.js';
import { UpstreamClient } from './infrastructure/http/upstream-client.js';
import { createCatalogImageHandler, createSignedImageHandler } from './infrastructure/media/image-proxy.js';
import { SignedMediaUrls } from './infrastructure/media/media-urls.js';
import { HttpStreamProber } from './infrastructure/media/stream-prober.js';
import { createStreamProxyHandler, mediaCorsHeaders } from './infrastructure/media/stream-proxy.js';
import type { Db } from './infrastructure/persistence/postgres/database.js';
import { PgAccountDataTransfer } from './infrastructure/persistence/postgres/repositories/account-data-transfer.js';
import {
  PgAdminQueries,
  PgAdminUnitOfWork,
  PgAuditRepository,
  PgOutboxRepository,
  PgStaffRepository,
  PgStaffSessionRepository,
} from './infrastructure/persistence/postgres/repositories/admin.repository.js';
import { LocalSecretStore } from './infrastructure/secrets/secret-store.js';
import { PgCatalogRepository } from './infrastructure/persistence/postgres/repositories/catalog.repository.js';
import { PgEmailTokenRepository } from './infrastructure/persistence/postgres/repositories/email-token.repository.js';
import { PgNotificationRepository } from './infrastructure/persistence/postgres/repositories/notification.repository.js';
import { PgScheduleRepository } from './infrastructure/persistence/postgres/repositories/schedule.repository.js';
import { PgSessionRepository } from './infrastructure/persistence/postgres/repositories/session.repository.js';
import { PgPlaylistEntryRepository } from './infrastructure/persistence/postgres/repositories/playlist-entry.repository.js';
import { PgPlaylistRepository } from './infrastructure/persistence/postgres/repositories/playlist.repository.js';
import { PgSourceRepository } from './infrastructure/persistence/postgres/repositories/source.repository.js';
import { PgUserRepository } from './infrastructure/persistence/postgres/repositories/user.repository.js';
import { M3uProvider } from './infrastructure/providers/m3u-provider.js';
import { XtreamProvider } from './infrastructure/providers/xtream-provider.js';
import { HttpXmltvReader } from './infrastructure/providers/xmltv-provider.js';
import {
  PgEpgMappingRepository,
  PgGuideChannelRepository,
  PgGuideRepository,
  PgProgrammeRepository,
} from './infrastructure/persistence/postgres/repositories/epg.repository.js';

export interface Container {
  clock: Clock;
  cache: Cache;
  upstream: UpstreamClient;
  mediaTokens: MediaTokenCodec;
  mediaGrants: MediaGrantChecker;
  secrets: SourceSecrets;
  /** Shared rate-limit stores (Redis) or null = per-instance memory. */
  rateLimitStores: ((name: string) => Store) | null;
  leases: LeaseStore;
  secretStore: SecretStore;
  admin: {
    auth: StaffAuthService;
    staff: StaffService;
    audit: AuditService;
    users: AdminUsersService;
    system: SystemOverviewService;
  };
  sessions: SessionService;
  accounts: AccountService;
  emailFlow: EmailFlowService;
  playlists: PlaylistService;
  playlistEntries: PlaylistEntryService;
  playlistExport: PlaylistExportService;
  viewers: ViewerResolver;
  sources: SourceService;
  live: LiveCatalogService;
  vod: VodCatalogService;
  epg: EpgService;
  playback: PlaybackService;
  notifications: NotificationService;
  jobs: JobRunner;
  media: {
    cors: RequestHandler;
    streamProxy: RequestHandler;
    catalogImages: RequestHandler;
    signedImages: RequestHandler;
  };
  dispose(): Promise<void>;
}

export interface ContainerOptions {
  /** The database connection; owned (created and closed) by the caller — `main.ts` or the test harness. */
  db: Db;
  clock?: Clock;
  /** Tests use a cheap hasher; production uses scrypt with OWASP parameters. */
  passwordHasher?: PasswordHasher;
  /** Overrides the configured mail transport; `null` turns email off. */
  mailer?: Mailer | null;
}

/**
 * Composition root: the only place that knows concrete implementations (the .NET equivalent of
 * `Program.cs` service registration). Use cases receive their collaborators through
 * constructors, so tests can swap any of them.
 */
export function buildContainer(config: AppConfig, logger: Logger, options: ContainerOptions): Container {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  // Shared state: with REDIS_URL, rate limits / cache invalidation / leases span every instance.
  const redis: Redis | null = config.redis.url ? createRedis(config.redis.url, config.redis.keyPrefix, logger.child({ module: 'redis' })) : null;
  const bus = redis ? new RedisInvalidationBus(redis, logger.child({ module: 'redis' })) : null;
  const coherent = (local: Cache): Cache => (bus ? new CoherentCache(local, bus) : local);
  const cache = coherent(new MemoryCache());
  // Grant decisions get their own cache: one entry per playing device / export link must never
  // evict catalog lists (or each other) from the shared 2 000-entry cache.
  const grantCache = coherent(new MemoryCache(50_000));
  const leases: LeaseStore = redis ? new RedisLeaseStore(redis) : new MemoryLeaseStore();
  const cipher = new AesSecretCipher(parseEncryptionKey(config.encryption.key), config.encryption.previousKeys.map(parseEncryptionKey));
  const secrets = new SourceSecrets(cipher);
  const upstream = new UpstreamClient(config.upstream);
  const mediaTokens = new MediaTokenCodec(config.stream.tokenSecret, config.stream.tokenTtlSeconds);
  const mediaUrls = new SignedMediaUrls(mediaTokens, MEDIA_PREFIX, config.playlistExport.linkTtlSeconds);
  const artwork = config.stream.delivery === 'proxy' ? proxiedArtwork(mediaUrls) : directArtwork;

  // --- persistence adapters ---------------------------------------------------------------------
  const userRepository = new PgUserRepository(db);
  const sessionRepository = new PgSessionRepository(db);
  const sourceRepository = new PgSourceRepository(db);
  const catalogRepository = new PgCatalogRepository(db);
  const notificationRepository = new PgNotificationRepository(db);
  const scheduleRepository = new PgScheduleRepository(db);

  // --- use cases -----------------------------------------------------------------------------
  const sessions = new SessionService(
    userRepository,
    sessionRepository,
    logger.child({ module: 'session' }),
    { accountSessionTtlMs: config.auth.sessionTtlDays * 24 * 3600_000 },
    () => clock.now(),
  );
  const viewers = accountViewerResolver;
  const notifications = new NotificationService(notificationRepository, clock, logger.child({ module: 'notifications' }));
  const m3u = new M3uProvider(upstream, { maxBytes: config.limits.maxSourceBytes, maxEntries: config.limits.maxEntriesPerSource });
  const xtream = new XtreamProvider(upstream, { maxBytes: config.limits.maxSourceBytes, maxEntries: config.limits.maxEntriesPerSource });
  const guideRepository = new PgGuideRepository(db);
  const guideChannelRepository = new PgGuideChannelRepository(db);
  const programmeRepository = new PgProgrammeRepository(db);
  const mappingRepository = new PgEpgMappingRepository(db);
  const jobs = new JobRunner(clock, logger.child({ module: 'jobs' }));
  const urlPolicy = { assertAllowed: (url: URL) => assertUpstreamUrlAllowed(url, config.upstream.allowPrivateNetworks) };
  // Channel matcher + guide lifecycle (attaches announced XMLTV guides, links channels, re-links on changes).
  const epgLinker = new SourceEpgLinker({
    sources: sourceRepository,
    catalog: catalogRepository,
    guides: guideRepository,
    guideChannels: guideChannelRepository,
    programmes: programmeRepository,
    mappings: mappingRepository,
    secrets,
    jobs,
    cache,
    clock,
    logger: logger.child({ module: 'epg-linker' }),
  });

  const playlistRepository = new PgPlaylistRepository(db);
  const playlistEntryRepository = new PgPlaylistEntryRepository(db);
  const mediaGrants = new MediaGrantChecker({ sessions: sessionRepository, playlists: playlistRepository, cache: grantCache, clock, exportMode: config.playlistExport.mode });
  sessions.onRevoked((ids) => ids.forEach((id) => mediaGrants.forget({ kind: 'session', id })));
  const pipeline = new SourceSyncPipeline({
    sources: sourceRepository,
    catalog: catalogRepository,
    providers: { m3u_url: m3u, xtream },
    secrets,
    epg: epgLinker,
    revisionListeners: [new PlaylistRelinker(playlistEntryRepository, logger.child({ module: 'playlists' }))],
    notifications,
    cache,
    clock,
    logger: logger.child({ module: 'source-sync' }),
  });

  const sources = new SourceService({
    sources: sourceRepository,
    catalog: catalogRepository,
    secrets,
    pipeline,
    fileParser: m3u,
    xtreamVerifier: xtream,
    epg: epgLinker,
    jobs,
    removalListeners: [epgLinker],
    urlPolicy,
    cache,
    clock,
    logger: logger.child({ module: 'sources' }),
    limits: { maxSourcesPerUser: config.limits.maxSourcesPerUser },
  });

  const playlists = new PlaylistService({
    playlists: playlistRepository,
    entries: playlistEntryRepository,
    cipher,
    limits: { maxPlaylistsPerUser: config.limits.maxPlaylistsPerUser },
    logger: logger.child({ module: 'playlists' }),
    exportMode: config.playlistExport.mode,
    onExportRevoked: (tokenHash) => mediaGrants.forget({ kind: 'export', id: tokenHash }),
  });
  const hasher = options.passwordHasher ?? new ScryptPasswordHasher();
  const mailer: Mailer | null =
    options.mailer !== undefined
      ? options.mailer
      : config.mail.smtpUrl && config.mail.from
        ? new SmtpMailer(config.mail.smtpUrl, config.mail.from)
        : config.mail.logOnly
          ? new LogMailer(logger.child({ module: 'mail' }))
          : null;
  const emailFlow = new EmailFlowService({
    users: userRepository,
    tokens: new PgEmailTokenRepository(db),
    sessions,
    hasher,
    mailer,
    publicUrl: config.publicUrl,
    clock: () => clock.now(),
    logger: logger.child({ module: 'email' }),
  });
  const accounts = new AccountService({
    users: userRepository,
    sessions,
    hasher,
    transfer: new PgAccountDataTransfer(db),
    sources: sourceRepository,
    playlists: playlistRepository,
    limits: { maxSourcesPerUser: config.limits.maxSourcesPerUser, maxPlaylistsPerUser: config.limits.maxPlaylistsPerUser },
    logger: logger.child({ module: 'accounts' }),
    afterRegister: (user) => emailFlow.sendVerificationTo(user),
  });

  const live = new LiveCatalogService({ sources: sourceRepository, catalog: catalogRepository, cache, artwork });
  const seriesEpisodes = new SeriesEpisodes({ catalog: catalogRepository, secrets, details: xtream, cache, clock, logger: logger.child({ module: 'series-episodes' }) });
  const vod = new VodCatalogService({ live, catalog: catalogRepository, episodes: seriesEpisodes, artwork });
  const epg = new EpgService({
    live,
    sources: sourceRepository,
    guides: guideRepository,
    guideChannels: guideChannelRepository,
    programmes: programmeRepository,
    mappings: mappingRepository,
    linker: epgLinker,
    secrets,
    media: mediaUrls,
    urlPolicy,
    jobs,
    cache,
    clock,
    delivery: config.stream.delivery,
  });
  const epgPipeline = new EpgSyncPipeline({
    guides: guideRepository,
    guideChannels: guideChannelRepository,
    programmes: programmeRepository,
    mappings: mappingRepository,
    sources: sourceRepository,
    catalog: catalogRepository,
    reader: new HttpXmltvReader(upstream, config.epg.maxBytes),
    linker: epgLinker,
    secrets,
    notifications,
    cache,
    clock,
    logger: logger.child({ module: 'epg-sync' }),
    intervalHours: config.jobs.epgSyncIntervalHours,
    daysAhead: config.epg.daysAhead,
  });
  const playback = new PlaybackService({
    live,
    sources: sourceRepository,
    catalog: catalogRepository,
    secrets,
    media: mediaUrls,
    prober: new HttpStreamProber(upstream, logger.child({ module: 'prober' })),
    proxyEnabled: config.stream.proxyEnabled,
    delivery: config.stream.delivery,
    artwork,
    streamUrls: new ProviderStreamUrls(secrets),
    episodes: seriesEpisodes,
  });

  // --- operator console -------------------------------------------------------------------------
  const staffRepository = new PgStaffRepository(db);
  const outboxRepository = new PgOutboxRepository(db);
  const adminUow = new PgAdminUnitOfWork(db);
  const adminQueries = new PgAdminQueries(db);
  const forgetSessionGrants = (ids: string[]) => ids.forEach((id) => mediaGrants.forget({ kind: 'session', id }));
  const admin = {
    auth: new StaffAuthService({
      staff: staffRepository,
      sessions: new PgStaffSessionRepository(db),
      uow: adminUow,
      hasher,
      cipher,
      clock,
      logger: logger.child({ module: 'staff-auth' }),
      config: { idleTimeoutMs: config.admin.idleTimeoutMs, absoluteTimeoutMs: config.admin.absoluteTimeoutMs, issuer: config.admin.mfaIssuer },
      jobs,
    }),
    staff: new StaffService({ staff: staffRepository, uow: adminUow, hasher, clock }),
    audit: new AuditService(new PgAuditRepository(db, false)),
    users: new AdminUsersService({ queries: adminQueries, sessions: sessionRepository, uow: adminUow, clock, onSessionsRevoked: forgetSessionGrants, jobs }),
    system: new SystemOverviewService({ queries: adminQueries, outbox: outboxRepository, clock }),
  };

  // Side effects committed with their cause (outbox) — handlers must be idempotent.
  const outboxHandlers = {
    [USER_SESSIONS_REVOKED]: async (payload: Record<string, unknown>) => {
      await notifications.notify({
        ownerId: String(payload.userId),
        type: 'account_security',
        severity: 'warning',
        title: 'You were signed out on all devices',
        body: 'ZIPTV support signed out every device on your account. Sign in again to continue.',
        link: null,
        dedupeKey: `sessions-revoked`,
      });
    },
    'staff.signed_in': async (payload: Record<string, unknown>) => {
      if (!mailer) return; // nothing to deliver without mail
      const at = String(payload.at);
      await mailer.send({
        to: String(payload.email),
        subject: 'New sign-in to the ZIPTV console',
        text: `Your console account signed in at ${at} from ${String(payload.ip ?? 'an unknown address')}. If this was not you, ask an administrator to disable the account and reset its two-factor authentication.`,
        html: `<p>Your console account signed in at <b>${escapeHtml(at)}</b> from <b>${escapeHtml(String(payload.ip ?? 'an unknown address'))}</b>.</p><p>If this was not you, ask an administrator to disable the account and reset its two-factor authentication.</p>`,
      });
    },
  };

  // --- background workers ---------------------------------------------------------------------
  jobs.register(
    createSourceSyncWorker({ sources: sourceRepository, pipeline, concurrency: config.jobs.sourceSyncConcurrency }),
    createEpgSyncWorker({ guides: guideRepository, pipeline: epgPipeline, concurrency: config.jobs.epgSyncConcurrency }),
    createOutboxWorker({ outbox: outboxRepository, handlers: outboxHandlers, clock, logger: logger.child({ module: 'outbox' }) }),
    periodicWorker({
      name: 'cleanup',
      intervalMs: 60 * 60_000,
      schedules: scheduleRepository,
      run: async () => {
        const purged = await notifications.purgeExpired();
        const expiredSessions = await sessions.purgeExpired();
        const expiredEmailTokens = await emailFlow.purgeExpired();
        const expiredStaffSessions = await admin.auth.purgeExpiredSessions();
        await outboxRepository.purgeProcessed(new Date(clock.now().getTime() - 30 * 86_400_000));
        // Programmes that ended before the longest archive (30 days) are useless.
        const endedProgrammes = await programmeRepository.deleteEndedBefore(new Date(clock.now().getTime() - 31 * 86_400_000));
        if (endedProgrammes > 0) logger.debug({ endedProgrammes }, 'Pruned ended programmes');
        logger.debug({ purged, expiredSessions, expiredEmailTokens, expiredStaffSessions }, 'Cleanup finished');
      },
    }),
  );

  // --- media (public) handlers --------------------------------------------------------------------
  const images = new CatalogImages({ sources: sourceRepository, catalog: catalogRepository, cache });
  const mediaLogger = logger.child({ module: 'media' });
  const media = {
    cors: mediaCorsHeaders as RequestHandler,
    streamProxy: createStreamProxyHandler({ tokens: mediaTokens, grants: mediaGrants, upstream, logger: mediaLogger, strictManifests: config.stream.delivery === 'proxy' }),
    catalogImages: createCatalogImageHandler({ lookup: (sourceId, type, key) => images.find(sourceId, type, key), tokens: mediaTokens, upstream, logger: mediaLogger }),
    signedImages: createSignedImageHandler({ lookup: async () => null, tokens: mediaTokens, upstream, logger: mediaLogger }),
  };

  return {
    clock,
    cache,
    upstream,
    mediaTokens,
    mediaGrants,
    secrets,
    rateLimitStores: redis ? redisRateLimitStores(redis, logger.child({ module: 'rate-limit' })) : null,
    leases,
    secretStore: new LocalSecretStore(cipher),
    admin,
    sessions,
    accounts,
    emailFlow,
    playlists,
    playlistEntries: new PlaylistEntryService({
      playlists,
      entries: playlistEntryRepository,
      sources: sourceRepository,
      liveChannels: live,
      limits: { maxEntriesPerPlaylist: config.limits.maxEntriesPerPlaylist },
      logger: logger.child({ module: 'playlists' }),
      artwork,
    }),
    playlistExport: new PlaylistExportService({
      playlists: playlistRepository,
      entries: playlistEntryRepository,
      secrets,
      formatter: new M3uFormatter(),
      media: mediaUrls,
      mode: config.playlistExport.mode,
      logger: logger.child({ module: 'playlist-export' }),
    }),
    viewers,
    sources,
    live,
    vod,
    epg,
    playback,
    notifications,
    jobs,
    media,
    dispose: async () => {
      await jobs.stop();
      await upstream.close();
      await bus?.close();
      if (redis) await redis.quit().catch(() => redis.disconnect());
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
