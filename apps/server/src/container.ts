import type { AppConfig } from './config/env.js';
import { streamProxyPath } from './http-paths.js';
import { UpstreamClient } from './infrastructure/http/upstream-client.js';
import type { Logger } from './infrastructure/logger.js';
import { PlaybackService } from './modules/playback/playback.service.js';
import { StreamProber } from './modules/playback/stream-prober.js';
import { StreamTokenCodec } from './modules/playback/stream-token.js';
import { ChannelModel, MongoChannelRepository, type ChannelRepository } from './modules/playlists/channel.repository.js';
import { PlaylistSourceFetcher } from './modules/playlists/playlist-source.js';
import { MongoPlaylistRepository, PlaylistModel, type PlaylistRepository } from './modules/playlists/playlist.repository.js';
import { PlaylistService } from './modules/playlists/playlist.service.js';
import { SessionService } from './modules/session/session.service.js';
import { MongoUserRepository, UserModel, type UserRepository } from './modules/session/user.repository.js';

export interface Container {
  upstream: UpstreamClient;
  tokens: StreamTokenCodec;
  sessions: SessionService;
  playlists: PlaylistService;
  playback: PlaybackService;
  dispose(): Promise<void>;
}

/** Lets tests (or another database) replace the persistence adapters. */
export interface RepositoryOverrides {
  users?: UserRepository;
  playlists?: PlaylistRepository;
  channels?: ChannelRepository;
}

/**
 * Composition root: the only place that knows concrete implementations.
 * Services receive their collaborators through constructors, so tests can swap any of them.
 */
export function buildContainer(config: AppConfig, logger: Logger, repositories: RepositoryOverrides = {}): Container {
  const upstream = new UpstreamClient(config.upstream);
  const tokens = new StreamTokenCodec(config.stream.tokenSecret, config.stream.tokenTtlSeconds);

  const sessions = new SessionService(repositories.users ?? new MongoUserRepository(), logger.child({ module: 'session' }));

  const playlists = new PlaylistService({
    playlists: repositories.playlists ?? new MongoPlaylistRepository(),
    channels: repositories.channels ?? new MongoChannelRepository(),
    fetcher: new PlaylistSourceFetcher(upstream, config.limits.maxPlaylistBytes),
    limits: config.limits,
    logger: logger.child({ module: 'playlists' }),
  });

  const playback = new PlaybackService({
    playlists,
    tokens,
    prober: new StreamProber(upstream, logger.child({ module: 'prober' })),
    proxyEnabled: config.stream.proxyEnabled,
    proxyPath: streamProxyPath,
  });

  return {
    upstream,
    tokens,
    sessions,
    playlists,
    playback,
    dispose: () => upstream.close(),
  };
}

/** Creates missing indexes before traffic is accepted (idempotent). */
export async function initPersistence(): Promise<void> {
  await Promise.all([UserModel.init(), PlaylistModel.init(), ChannelModel.init()]);
}
