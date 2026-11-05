import type { RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';

import { AccountBillingService } from './application/commerce/account-billing.service.js';
import { BillingService, CANCEL_AT_PROCESSOR, SUBSCRIPTION_CHANGED, VOID_AT_PROCESSOR } from './application/commerce/billing.service.js';
import { CommerceAdminService } from './application/commerce/commerce-admin.service.js';
import { EntitlementService } from './application/commerce/entitlement.service.js';
import { PlaybackAuthorizationService } from './application/commerce/playback-authorization.service.js';
import type { GeoResolver } from './application/ports/geo.js';
import { FakePaymentProcessor } from './infrastructure/billing/fake-processor.js';
import { NoPaymentProcessor } from './infrastructure/billing/no-processor.js';
import { StaticGeoResolver } from './infrastructure/geo/static-geo.js';
import { PgCommerceRepository } from './infrastructure/persistence/postgres/repositories/commerce.repository.js';
import { PgLeaseStore } from './infrastructure/persistence/postgres/repositories/lease-store.js';
import { AdminUsersService, USER_SESSIONS_REVOKED } from './application/admin/admin-users.service.js';
import { ChangeRequestService } from './application/admin/change-requests.service.js';
import { ConsoleService, PLAYBACK_SESSION_RETENTION_DAYS } from './application/admin/console.service.js';
import { PgConsoleQueries } from './infrastructure/persistence/postgres/repositories/console.queries.js';
import { PgChangeRequestRepository } from './infrastructure/persistence/postgres/repositories/change-request.repository.js';
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
import { ParentalService } from './application/identity/parental.service.js';
import { ProfileViewerResolver } from './application/identity/profile-viewer-resolver.js';
import { HmacUnlockTokens } from './infrastructure/crypto/unlock-tokens.js';
import { PgParentalRepository } from './infrastructure/persistence/postgres/repositories/parental.repository.js';
import { PgLibraryRepository } from './infrastructure/persistence/postgres/repositories/library.repository.js';
import { LibraryService } from './application/identity/library.service.js';
import { ProfileService } from './application/identity/profile.service.js';
import type { ViewerResolver } from './application/identity/viewer-resolver.js';
import { SearchService } from './application/catalog/search.service.js';
import { invalidateHome } from './application/user-state/cache-keys.js';
import { HomeService } from './application/user-state/home.service.js';
import { MyListService } from './application/user-state/my-list.service.js';
import { ViewerDataService } from './application/user-state/viewer-data.service.js';
import { WatchObserver } from './application/user-state/watch-observer.js';
import { WatchStateService } from './application/user-state/watch-state.service.js';
import { MAX_PROFILES } from './domain/viewer/profile.js';
import { HISTORY_MIN_SECS } from './domain/viewer/progress.js';
import { DEFAULT_SETTINGS } from './domain/viewer/settings.js';
import { PgProfileRepository } from './infrastructure/persistence/postgres/repositories/profile.repository.js';
import { PgHistoryRepository, PgListRepository, PgProgressRepository } from './infrastructure/persistence/postgres/repositories/user-state.repository.js';
import { createFeedProbeWorker, FeedProbeService } from './application/health/feed-probe.service.js';
import { HealthEvaluator } from './application/health/health-evaluator.js';
import { MonitoringAdminService } from './application/health/monitoring-admin.service.js';
import { PlaybackTelemetry } from './application/health/playback-telemetry.js';
import { createSourceHealthWorker, SourceHealthService } from './application/health/source-health.service.js';
import { FeedLocators } from './application/operator/feed-locators.js';
import { CatalogAdminService } from './application/operator/catalog-admin.service.js';
import { HmacTelemetryTokens } from './infrastructure/crypto/telemetry-tokens.js';
import { alertChannels, createAlertHandlers } from './infrastructure/alerts/incident-alerts.js';
import { HttpFeedProber } from './infrastructure/health/feed-prober.js';
import { FfprobeDecoder } from './infrastructure/health/ffprobe-decoder.js';
import { HttpSourceEndpointChecker } from './infrastructure/health/source-endpoint-checker.js';
import { PrometheusMetrics } from './infrastructure/metrics/prometheus.js';
import { PgHealthRepository, PgSourceHealthRepository } from './infrastructure/persistence/postgres/repositories/health.repository.js';
import { sourceCachePrefix } from './application/sources/source-sync.pipeline.js';
import { OperatorService } from './application/operator/operator.service.js';
import { createOperatorEpgWorker, OperatorEpgService } from './application/operator/operator-epg.service.js';
import { PgOperatorEpgRepository } from './infrastructure/persistence/postgres/repositories/operator-epg.repository.js';
import { ProviderConnections } from './application/operator/provider-connections.js';
import { createProviderSyncWorker, ProviderSyncService } from './application/operator/provider-sync.js';
import { createProviderAdapters } from './infrastructure/operator/provider-adapters.js';
import { PgOperatorCatalogRepository } from './infrastructure/persistence/postgres/repositories/operator-catalog.repository.js';
import { JobRunner, periodicWorker } from './application/jobs/job-runner.js';
import { NotificationService } from './application/notifications/notification.service.js';
import { MediaGrantChecker } from './application/playback/media-grants.js';
import { PlaybackService } from './application/playback/playback.service.js';
import { SourceConnections } from './application/playback/source-connections.js';
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
import { createArchiveRedirectHandler } from './infrastructure/media/archive-redirect.js';
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
    catalog: CatalogAdminService;
    monitoring: MonitoringAdminService;
    commerce: CommerceAdminService;
    changes: ChangeRequestService;
    console: ConsoleService;
    epg: OperatorEpgService;
  };
  commerce: {
    billing: BillingService;
    accounts: AccountBillingService;
    entitlements: EntitlementService;
    authorization: PlaybackAuthorizationService;
    /** The built-in test processor (null with a real or no processor): hosted page, renewals in tests. */
    fakeProcessor: FakePaymentProcessor | null;
    /** Playback concurrency leases (Redis when configured, else PostgreSQL — never per-instance memory). */
    streamLeases: LeaseStore;
  };
  geo: GeoResolver | null;
  sessions: SessionService;
  accounts: AccountService;
  emailFlow: EmailFlowService;
  playlists: PlaylistService;
  playlistEntries: PlaylistEntryService;
  playlistExport: PlaylistExportService;
  viewers: ViewerResolver;
  parental: ParentalService;
  profiles: ProfileService;
  library: LibraryService;
  myList: MyListService;
  watch: WatchStateService;
  viewerData: ViewerDataService;
  home: HomeService;
  search: SearchService;
  sources: SourceService;
  live: LiveCatalogService;
  vod: VodCatalogService;
  epg: EpgService;
  playback: PlaybackService;
  operator: OperatorService;
  operatorEpg: OperatorEpgService;
  metrics: PrometheusMetrics;
  notifications: NotificationService;
  jobs: JobRunner;
  media: {
    cors: RequestHandler;
    streamProxy: RequestHandler;
    archive: RequestHandler;
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
  const profileRepository = new PgProfileRepository(db);
  const listRepository = new PgListRepository(db);
  const progressRepository = new PgProgressRepository(db);
  const historyRepository = new PgHistoryRepository(db);
  const profiles = new ProfileService({ profiles: profileRepository, cache, limits: { maxProfiles: MAX_PROFILES } });
  const library = new LibraryService({ library: new PgLibraryRepository(db), sources: sourceRepository, profiles, cache });
  profiles.useLibrary(library);
  const notifications = new NotificationService(notificationRepository, clock, logger.child({ module: 'notifications' }));
  const parental = new ParentalService({
    parental: new PgParentalRepository(db),
    profiles,
    profileStore: profileRepository,
    sessions: sessionRepository,
    sources: sourceRepository,
    library,
    hasher: options.passwordHasher ?? new ScryptPasswordHasher(),
    tokens: new HmacUnlockTokens(config.stream.tokenSecret),
    cache,
    clock,
    unlockTtlSeconds: config.parental.unlockTtlSeconds,
    notifications,
  });
  profiles.useGuard(parental);
  library.useGuard(parental);
  const viewers: ViewerResolver = new ProfileViewerResolver(parental);
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
  // --- commerce (ZP-ENT-07/08/09): entitlements gate operator playback ---------------------------
  const commerceRepository = new PgCommerceRepository(db);
  const pgLeases = redis ? null : new PgLeaseStore(db);
  // A concurrency limit enforced per instance is no limit: Redis (Lua) or PostgreSQL, never memory.
  const streamLeases: LeaseStore = redis ? new RedisLeaseStore(redis) : pgLeases!;
  const entitlements = new EntitlementService({ commerce: commerceRepository, clock, mode: config.commerce.access, defaults: config.commerce.defaults });
  const geo: GeoResolver | null = config.commerce.geoStaticRanges ? new StaticGeoResolver(config.commerce.geoStaticRanges) : null;
  const mediaGrants = new MediaGrantChecker({ sessions: sessionRepository, playlists: playlistRepository, playbackSessions: commerceRepository, cache: grantCache, clock, exportMode: config.playlistExport.mode });
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
    library,
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
    profiles: {
      listByUser: (userId) => profileRepository.listByUser(userId),
      max: MAX_PROFILES,
      afterMerge: async (accountId) => {
        profiles.forget(accountId);
        await library.changed(accountId, (await profiles.records(accountId)).map((profile) => profile.id));
        for (const profile of await profiles.records(accountId)) invalidateHome(cache, profile.id);
      },
    },
  });

  const live = new LiveCatalogService({ sources: sourceRepository, catalog: catalogRepository, cache, artwork });
  const seriesEpisodes = new SeriesEpisodes({ catalog: catalogRepository, secrets, details: xtream, cache, clock, logger: logger.child({ module: 'series-episodes' }) });
  const vod = new VodCatalogService({ live, catalog: catalogRepository, episodes: seriesEpisodes, list: listRepository, progress: progressRepository, cache, artwork });
  // --- stream health (ZP-ENT-06): repositories and metrics shared by playback, probes and console --
  const healthRepository = new PgHealthRepository(db);
  const metrics = new PrometheusMetrics({
    defaults: config.env !== 'test',
    labels: { role: config.role },
    state: { feeds: () => healthRepository.statusCounts(), incidents: () => healthRepository.openIncidentCounts() },
  });
  const telemetry = new PlaybackTelemetry({
    tokens: new HmacTelemetryTokens(config.stream.tokenSecret),
    health: healthRepository,
    cache,
    clock,
    metrics,
    logger: logger.child({ module: 'telemetry' }),
  });

  // --- operator catalog (licensed channels, ZP-ENT-03) --------------------------------------------
  const secretStore = new LocalSecretStore(cipher);
  const operatorCatalog = new PgOperatorCatalogRepository(db);
  const providerAdapters = createProviderAdapters({ m3u, xtream, openLocator: (sealed) => secrets.openLocator(sealed) });
  const providerConnections = new ProviderConnections({ secrets: secretStore, urlPolicy });
  const operator = new OperatorService({
    catalog: operatorCatalog,
    adapters: providerAdapters,
    connections: providerConnections,
    sources: sourceRepository,
    byoCatalog: catalogRepository,
    list: listRepository,
    cache,
    clock,
    logger: logger.child({ module: 'operator' }),
    artwork,
    health: healthRepository,
    entitlements,
  });
  const providerSync = new ProviderSyncService({ catalog: operatorCatalog, adapters: providerAdapters, connections: providerConnections, secrets, clock, logger: logger.child({ module: 'provider-sync' }) });
  const myList = new MyListService({ list: listRepository, sources: sourceRepository, catalog: catalogRepository, cache, artwork, operatorFavorites: (viewer) => operator.favoriteListItems(viewer) });
  const watch = new WatchStateService({ progress: progressRepository, history: historyRepository, cache, artwork });
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
    timeShift: async (viewer) => (await profiles.settingsOf(viewer)).epg.timeShiftMinutes * 60_000,
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
    operator,
    operatorAccess: config.commerce.access,
    programmes: epg,
    connections: new SourceConnections(leases),
    // Operator guide is built further down; only called while serving requests.
    operatorProgrammes: { programmeAt: (channelId, start) => operatorEpg.programmeAt(channelId, start) },
    clock,
    telemetry,
    metrics,
    observer: new WatchObserver({
      history: historyRepository,
      progress: progressRepository,
      cache,
      clock,
      logger: logger.child({ module: 'watch' }),
      resumeEnabled: async (viewer) => (await profiles.settingsOf(viewer)).playback.resumePlayback,
    }),
  });
  const home = new HomeService({
    sources: sourceRepository,
    sourceService: sources,
    catalog: catalogRepository,
    live,
    epg,
    myList,
    watch,
    cache,
    logger: logger.child({ module: 'home' }),
    artwork,
  });
  const search = new SearchService({ sources: sourceRepository, catalog: catalogRepository, live, epg, logger: logger.child({ module: 'search' }), artwork });
  const viewerData = new ViewerDataService({ sources: sourceRepository, catalog: catalogRepository, list: listRepository, progress: progressRepository, history: historyRepository, epg, cache, clock });

  const commerceLogger = logger.child({ module: 'commerce' });
  const authorization = new PlaybackAuthorizationService({
    commerce: commerceRepository,
    entitlements,
    operator,
    playback,
    leases: streamLeases,
    clock,
    logger: commerceLogger,
    onEnded: (id) => mediaGrants.forget({ kind: 'playback', id }),
  });
  // eslint-disable-next-line prefer-const -- assigned after the processor that delivers to it
  let billing: BillingService;
  const fakeProcessor =
    config.commerce.processor === 'fake'
      ? new FakePaymentProcessor({
          secret: config.commerce.fakeSecret,
          baseUrl: () => config.publicUrl ?? `http://localhost:${config.http.port}`,
          clock,
          // In-process "HTTPS" delivery through the same entry point as a real webhook.
          deliver: async (body, headers) => void (await billing.handleWebhook('fake', body, headers)),
          onDeliveryError: (error) => commerceLogger.warn({ err: error }, 'Fake processor webhook delivery failed'),
        })
      : null;
  billing = new BillingService({ commerce: commerceRepository, processor: fakeProcessor ?? new NoPaymentProcessor(), clock, logger: commerceLogger, dunning: config.commerce.dunning });
  const accountBilling = new AccountBillingService({ commerce: commerceRepository, billing, entitlements, authorization, clock });

  // --- operator console -------------------------------------------------------------------------
  const staffRepository = new PgStaffRepository(db);
  const outboxRepository = new PgOutboxRepository(db);
  const adminUow = new PgAdminUnitOfWork(db);
  const adminQueries = new PgAdminQueries(db);
  const forgetSessionGrants = (ids: string[]) => ids.forEach((id) => mediaGrants.forget({ kind: 'session', id }));
  // --- stream health: probes, failover, incidents, BYO source checks ------------------------------
  const healthLogger = logger.child({ module: 'health' });
  const evaluator = new HealthEvaluator({
    health: healthRepository,
    catalog: operatorCatalog,
    clock,
    metrics,
    logger: healthLogger,
    config: {
      // A region that missed ~3 probes no longer votes.
      freshnessMs: config.health.intervalMs * 3 + 60_000,
      failover: { cooldownMs: config.health.failoverCooldownMs },
      alertChannels: alertChannels(config.alerts, mailer),
    },
  });
  const feedProbes = new FeedProbeService({
    health: healthRepository,
    locators: new FeedLocators({ catalog: operatorCatalog, adapters: providerAdapters, connections: providerConnections }),
    catalog: operatorCatalog,
    prober: new HttpFeedProber(upstream, config.health.decodeEveryMs > 0 ? new FfprobeDecoder(config.health.ffprobePath) : null),
    evaluator,
    clock,
    metrics,
    logger: healthLogger,
    schedule: {
      region: config.health.region,
      intervalMs: config.health.intervalMs,
      failingIntervalMs: config.health.failingIntervalMs,
      decodeEveryMs: config.health.decodeEveryMs,
      policy: { failAfter: config.health.failAfter, recoverAfter: config.health.recoverAfter },
    },
  });
  const sourceHealthRepository = new PgSourceHealthRepository(db);
  const sourceHealth = new SourceHealthService({
    sources: sourceRepository,
    secrets,
    checker: new HttpSourceEndpointChecker(upstream, xtream),
    repository: sourceHealthRepository,
    telemetry: healthRepository,
    clock,
    logger: healthLogger,
    intervalMs: config.health.sourceIntervalMs,
    onChange: (sourceId) => cache.deleteByPrefix(sourceCachePrefix(sourceId)),
  });
  const monitoring = new MonitoringAdminService({
    health: healthRepository,
    catalog: operatorCatalog,
    evaluator,
    uow: adminUow,
    clock,
    regions: config.health.regions,
  });

  // Four-eyes control: package/price changes and new rights grants are approved by a second person.
  const consoleQueries = new PgConsoleQueries(db);
  const operatorEpgRepository = new PgOperatorEpgRepository(db);
  const operatorEpg = new OperatorEpgService({
    epg: operatorEpgRepository,
    reader: new HttpXmltvReader(upstream, config.epg.maxBytes),
    secrets,
    urlPolicy,
    uow: adminUow,
    clock,
    logger: logger.child({ module: 'operator-epg' }),
    jobs,
    daysAhead: config.epg.daysAhead,
  });
  const changes = new ChangeRequestService({ uow: adminUow, requests: new PgChangeRequestRepository(db), staff: staffRepository, clock, logger: logger.child({ module: 'changes' }), fourEyes: config.admin.fourEyes });
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
    system: new SystemOverviewService({ queries: adminQueries, outbox: outboxRepository, clock, console: consoleQueries, health: healthRepository, changes }),
    catalog: new CatalogAdminService({
      catalog: operatorCatalog,
      uow: adminUow,
      adapters: providerAdapters,
      connections: providerConnections,
      secrets: secretStore,
      sync: providerSync,
      jobs,
      clock,
      allowMockProviders: config.operator.allowMockProviders,
      onChange: () => operator.forget(),
      channelStats: (ids) => consoleQueries.channelStats(ids),
      changes,
      onRightsRevoked: (channelId) => authorization.revalidateChannel(channelId),
    }),
    monitoring,
    commerce: new CommerceAdminService({
      commerce: commerceRepository,
      catalog: operatorCatalog,
      changes,
      billing,
      accounts: accountBilling,
      authorization,
      uow: adminUow,
      clock,
      onCatalogChange: () => operator.forget(),
    }),
    changes,
    epg: operatorEpg,
    console: new ConsoleService({ queries: consoleQueries, users: adminQueries, audit: new PgAuditRepository(db, false), uow: adminUow, clock, probeRetentionDays: config.health.retentionDays }),
  };
  changes.register(...admin.catalog.changeHandlers(), ...admin.commerce.changeHandlers());

  // Side effects committed with their cause (outbox) — handlers must be idempotent.
  const outboxHandlers = {
    ...createAlertHandlers({ config: config.alerts, mailer, findIncident: (id) => healthRepository.findIncident(id), consoleUrl: null, logger: healthLogger }),
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
    [SUBSCRIPTION_CHANGED]: async (payload: Record<string, unknown>) => {
      // Lost access (refund, cancel now, expiry): live viewings end now, not at the next heartbeat.
      const ended = await authorization.revalidate(String(payload.userId));
      if (ended > 0) commerceLogger.info({ userId: payload.userId, ended }, 'Ended viewings after a subscription change');
      const message = subscriptionMessage(String(payload.to), payload.cancelAtPeriodEnd === true);
      if (!message) return;
      await notifications.notify({
        ownerId: String(payload.userId),
        type: 'billing',
        severity: message.severity,
        title: message.title,
        body: message.body,
        link: '/account',
        dedupeKey: `subscription:${String(payload.subscriptionId)}:${String(payload.to)}:${String(payload.cancelAtPeriodEnd)}`,
      });
    },
    [CANCEL_AT_PROCESSOR]: async (payload: Record<string, unknown>) => {
      await billing.cancelAtProcessor(String(payload.subscriptionRef));
    },
    [VOID_AT_PROCESSOR]: async (payload: Record<string, unknown>) => {
      await billing.voidAtProcessor(String(payload.subscriptionRef), String(payload.reason));
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
    createProviderSyncWorker({ catalog: operatorCatalog, sync: providerSync }),
    createOperatorEpgWorker({ epg: operatorEpgRepository, service: operatorEpg }),
    createOutboxWorker({ outbox: outboxRepository, handlers: outboxHandlers, clock, logger: logger.child({ module: 'outbox' }) }),
    createSourceHealthWorker({ repository: sourceHealthRepository, service: sourceHealth, clock, logger: healthLogger }),
    // Fail-back after the cooldown and pin expiry need a decision even when no probe changes anything.
    periodicWorker({
      name: 'failover-reconcile',
      intervalMs: 60_000,
      schedules: scheduleRepository,
      leaseMs: 5 * 60_000,
      run: async (lease) => {
        for (const channelId of await healthRepository.channelsWithFeeds()) {
          if (lease.signal.aborted) return;
          // One broken channel must not stop the others' fail-back / pin expiry.
          await evaluator.evaluateChannel(channelId).catch((error: unknown) => healthLogger.warn({ err: error, channelId }, 'Failover reconcile failed for a channel'));
        }
        const orphans = await evaluator.resolveOrphans();
        if (orphans > 0) healthLogger.info({ orphans }, 'Resolved incidents of targets that left the catalog');
      },
    }),
    // New channels / aliases (provider syncs, console edits) get their guide channel automatically.
    periodicWorker({ name: 'operator-epg-automap', intervalMs: 10 * 60_000, schedules: scheduleRepository, run: async () => void (await operatorEpg.automap()) }),
    // Subscription state follows time (trial end, period end, dunning) even without webhooks.
    periodicWorker({
      name: 'subscription-clock',
      intervalMs: 5 * 60_000,
      schedules: scheduleRepository,
      run: async () => {
        const changed = await billing.runClock();
        if (changed > 0) commerceLogger.info({ changed }, 'Subscription clock advanced subscriptions');
      },
    }),
    // Missed or lost webhooks: compare with the processor's own records.
    periodicWorker({
      name: 'billing-reconcile',
      intervalMs: 60 * 60_000,
      schedules: scheduleRepository,
      leaseMs: 30 * 60_000,
      run: async () => {
        const result = await billing.reconcile({ olderThanMs: 6 * 3600_000, limit: 500 });
        commerceLogger.info(result, 'Billing reconciliation finished');
      },
    }),
    periodicWorker({
      name: 'playback-sessions',
      intervalMs: 60_000,
      schedules: scheduleRepository,
      run: async () => {
        const expired = await authorization.expireStale();
        const purgedLeases = pgLeases ? await pgLeases.purgeExpired() : 0;
        if (expired > 0 || purgedLeases > 0) commerceLogger.debug({ expired, purgedLeases }, 'Closed stale playback sessions');
      },
    }),
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
        const prunedHistory = await historyRepository.prune(clock.now(), DEFAULT_SETTINGS.data.historyRetentionDays, HISTORY_MIN_SECS);
        if (prunedHistory > 0) logger.debug({ prunedHistory }, 'Pruned watch history');
        const endedProgrammes = await programmeRepository.deleteEndedBefore(new Date(clock.now().getTime() - 31 * 86_400_000));
        if (endedProgrammes > 0) logger.debug({ endedProgrammes }, 'Pruned ended programmes');
        const day = 86_400_000;
        const now = clock.now().getTime();
        const prunedCommerce = await commerceRepository.pruneCommerce({ endedSessions: new Date(now - PLAYBACK_SESSION_RETENTION_DAYS * day), expiredCheckouts: new Date(now - 90 * day) });
        logger.debug({ prunedCommerce }, 'Pruned commerce data');
        const prunedHealth = await healthRepository.prune({
          probes: new Date(now - config.health.retentionDays * day),
          telemetry: new Date(now - 7 * day),
          failoverEvents: new Date(now - 180 * day),
          incidents: new Date(now - 180 * day),
        });
        logger.debug({ prunedHealth }, 'Pruned health data');
        logger.debug({ purged, expiredSessions, expiredEmailTokens, expiredStaffSessions }, 'Cleanup finished');
      },
    }),
  );

  if (config.health.probesEnabled) {
    jobs.register(createFeedProbeWorker({ health: healthRepository, probes: feedProbes, clock, region: config.health.region, concurrency: config.health.concurrency, providerLimit: config.health.providerConcurrency, logger: healthLogger }));
  }

  // --- media (public) handlers --------------------------------------------------------------------
  const images = new CatalogImages({ sources: sourceRepository, catalog: catalogRepository, cache });
  const mediaLogger = logger.child({ module: 'media' });
  const media = {
    cors: mediaCorsHeaders as RequestHandler,
    streamProxy: createStreamProxyHandler({ tokens: mediaTokens, grants: mediaGrants, upstream, logger: mediaLogger, strictManifests: config.stream.delivery === 'proxy' }),
    archive: createArchiveRedirectHandler({ tokens: mediaTokens, media: mediaUrls, grants: mediaGrants }),
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
    secretStore,
    admin,
    commerce: { billing, accounts: accountBilling, entitlements, authorization, fakeProcessor, streamLeases },
    geo,
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
    parental,
    profiles,
    library,
    myList,
    watch,
    viewerData,
    home,
    search,
    sources,
    live,
    vod,
    epg,
    playback,
    operator,
    operatorEpg,
    metrics,
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

function subscriptionMessage(status: string, cancelAtPeriodEnd: boolean): { severity: 'info' | 'warning'; title: string; body: string } | null {
  switch (status) {
    case 'trialing':
      return { severity: 'info', title: 'Your free trial has started', body: 'Enjoy every channel in your package. You can cancel any time before the trial ends.' };
    case 'active':
      return cancelAtPeriodEnd
        ? { severity: 'info', title: 'Your subscription will end', body: 'It stays active until the end of the paid period. You can resume it from your account.' }
        : { severity: 'info', title: 'Your subscription is active', body: 'Thanks — your package is ready to watch.' };
    case 'past_due':
      return { severity: 'warning', title: 'Payment failed', body: 'We could not renew your subscription. Update your payment method to keep watching.' };
    case 'grace':
      return { severity: 'warning', title: 'Your subscription is about to lapse', body: 'The renewal is still unpaid. Access ends in a few days unless the payment goes through.' };
    case 'canceled':
      return { severity: 'info', title: 'Your subscription was canceled', body: 'You can subscribe again at any time from the plans page.' };
    case 'expired':
      return { severity: 'warning', title: 'Your subscription has ended', body: 'Subscribe again to keep watching your package.' };
    default:
      return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
