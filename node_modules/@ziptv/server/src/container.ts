import type { RequestHandler } from 'express';

import { CatalogImages } from './application/catalog/catalog-images.js';
import { LiveCatalogService } from './application/catalog/live.service.js';
import { SessionService } from './application/identity/session.service.js';
import { accountViewerResolver, type ViewerResolver } from './application/identity/viewer-resolver.js';
import { JobRunner, periodicWorker } from './application/jobs/job-runner.js';
import { NotificationService } from './application/notifications/notification.service.js';
import { PlaybackService } from './application/playback/playback.service.js';
import type { Cache } from './application/ports/cache.js';
import { systemClock, type Clock } from './application/ports/clock.js';
import type { Logger } from './application/ports/logger.js';
import { noopEpgLinker } from './application/sources/hooks.js';
import { SourceSecrets } from './application/sources/secrets.js';
import { SourceService } from './application/sources/source.service.js';
import { SourceSyncPipeline } from './application/sources/source-sync.pipeline.js';
import { createSourceSyncWorker } from './application/sources/source-sync.worker.js';
import type { AppConfig } from './config/env.js';
import { MEDIA_PREFIX } from './api/http-paths.js';
import { MemoryCache } from './infrastructure/cache/memory-cache.js';
import { MediaTokenCodec } from './infrastructure/crypto/media-token.js';
import { AesSecretCipher, parseEncryptionKey } from './infrastructure/crypto/secret-cipher.js';
import { assertUpstreamUrlAllowed } from './infrastructure/http/network-policy.js';
import { UpstreamClient } from './infrastructure/http/upstream-client.js';
import { createCatalogImageHandler, createSignedImageHandler } from './infrastructure/media/image-proxy.js';
import { SignedMediaUrls } from './infrastructure/media/media-urls.js';
import { HttpStreamProber } from './infrastructure/media/stream-prober.js';
import { createStreamProxyHandler, mediaCorsHeaders } from './infrastructure/media/stream-proxy.js';
import { MongoCatalogRepository } from './infrastructure/persistence/mongo/repositories/catalog.repository.js';
import { MongoNotificationRepository } from './infrastructure/persistence/mongo/repositories/notification.repository.js';
import { MongoScheduleRepository } from './infrastructure/persistence/mongo/repositories/schedule.repository.js';
import { MongoSourceRepository } from './infrastructure/persistence/mongo/repositories/source.repository.js';
import { MongoUserRepository } from './infrastructure/persistence/mongo/repositories/user.repository.js';
import { M3uProvider } from './infrastructure/providers/m3u-provider.js';

export interface Container {
  clock: Clock;
  cache: Cache;
  upstream: UpstreamClient;
  mediaTokens: MediaTokenCodec;
  secrets: SourceSecrets;
  sessions: SessionService;
  viewers: ViewerResolver;
  sources: SourceService;
  live: LiveCatalogService;
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
  clock?: Clock;
}

/**
 * Composition root: the only place that knows concrete implementations (the .NET equivalent of
 * `Program.cs` service registration). Use cases receive their collaborators through
 * constructors, so tests can swap any of them.
 */
export function buildContainer(config: AppConfig, logger: Logger, options: ContainerOptions = {}): Container {
  const clock = options.clock ?? systemClock;
  const cache = new MemoryCache();
  const cipher = new AesSecretCipher(parseEncryptionKey(config.encryption.key), config.encryption.previousKeys.map(parseEncryptionKey));
  const secrets = new SourceSecrets(cipher);
  const upstream = new UpstreamClient(config.upstream);
  const mediaTokens = new MediaTokenCodec(config.stream.tokenSecret, config.stream.tokenTtlSeconds);
  const mediaUrls = new SignedMediaUrls(mediaTokens, MEDIA_PREFIX);

  // --- persistence adapters ---------------------------------------------------------------------
  const userRepository = new MongoUserRepository();
  const sourceRepository = new MongoSourceRepository();
  const catalogRepository = new MongoCatalogRepository();
  const notificationRepository = new MongoNotificationRepository();
  const scheduleRepository = new MongoScheduleRepository();

  // --- use cases -----------------------------------------------------------------------------
  const sessions = new SessionService(userRepository, logger.child({ module: 'session' }));
  const viewers = accountViewerResolver;
  const notifications = new NotificationService(notificationRepository, clock, logger.child({ module: 'notifications' }));
  const m3u = new M3uProvider(upstream, { maxBytes: config.limits.maxSourceBytes, maxEntries: config.limits.maxEntriesPerSource });
  const epgLinker = noopEpgLinker;

  const pipeline = new SourceSyncPipeline({
    sources: sourceRepository,
    catalog: catalogRepository,
    providers: { m3u_url: m3u },
    secrets,
    epg: epgLinker,
    notifications,
    cache,
    clock,
    logger: logger.child({ module: 'source-sync' }),
  });

  const jobs = new JobRunner(clock, logger.child({ module: 'jobs' }));

  const sources = new SourceService({
    sources: sourceRepository,
    catalog: catalogRepository,
    secrets,
    pipeline,
    fileParser: m3u,
    epg: epgLinker,
    jobs,
    removalListeners: [],
    urlPolicy: { assertAllowed: (url) => assertUpstreamUrlAllowed(url, config.upstream.allowPrivateNetworks) },
    cache,
    clock,
    logger: logger.child({ module: 'sources' }),
    limits: { maxSourcesPerUser: config.limits.maxSourcesPerUser },
  });

  const live = new LiveCatalogService({ sources: sourceRepository, catalog: catalogRepository, cache });
  const playback = new PlaybackService({
    live,
    sources: sourceRepository,
    catalog: catalogRepository,
    secrets,
    media: mediaUrls,
    prober: new HttpStreamProber(upstream, logger.child({ module: 'prober' })),
    proxyEnabled: config.stream.proxyEnabled,
  });

  // --- background workers ---------------------------------------------------------------------
  jobs.register(
    createSourceSyncWorker({ sources: sourceRepository, pipeline, concurrency: config.jobs.sourceSyncConcurrency }),
    periodicWorker({
      name: 'cleanup',
      intervalMs: 60 * 60_000,
      schedules: scheduleRepository,
      run: async () => {
        const purged = await notifications.purgeExpired();
        logger.debug({ purged }, 'Cleanup finished');
      },
    }),
  );

  // --- media (public) handlers --------------------------------------------------------------------
  const images = new CatalogImages({ sources: sourceRepository, catalog: catalogRepository, cache });
  const mediaLogger = logger.child({ module: 'media' });
  const media = {
    cors: mediaCorsHeaders as RequestHandler,
    streamProxy: createStreamProxyHandler({ tokens: mediaTokens, upstream, logger: mediaLogger }),
    catalogImages: createCatalogImageHandler({ lookup: (sourceId, type, key) => images.find(sourceId, type, key), tokens: mediaTokens, upstream, logger: mediaLogger }),
    signedImages: createSignedImageHandler({ lookup: async () => null, tokens: mediaTokens, upstream, logger: mediaLogger }),
  };

  return {
    clock,
    cache,
    upstream,
    mediaTokens,
    secrets,
    sessions,
    viewers,
    sources,
    live,
    playback,
    notifications,
    jobs,
    media,
    dispose: async () => {
      await jobs.stop();
      await upstream.close();
    },
  };
}
