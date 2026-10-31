import { randomUUID } from 'node:crypto';

import type { SourceDto, UpdateSourceRequest } from '@ziptv/contracts';

import {
  clampInterval,
  DEFAULT_SYNC_INTERVAL_HOURS,
  isSyncable,
  nextSyncAt,
  type SourceCredential,
} from '../../domain/sources/source.js';
import { parseXtreamPlaylistUrl } from '../../domain/sources/xtream.js';
import { AppError } from '../errors.js';
import type { Cache } from '../ports/cache.js';
import { SourceFetchError, type AccountVerifier, type PlaylistFileParser } from '../ports/catalog-provider.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { SourceOrigin, SourceRecord, SourceRepository, SourceSyncState } from '../ports/source-repository.js';
import type { UrlPolicy } from '../ports/url-policy.js';
import type { CatalogEpgLinker, JobKicker, SourceRemovalListener } from './hooks.js';
import type { SourceSecrets } from './secrets.js';
import { toSourceDto } from './source-mapper.js';
import { classifyFailure, sourceCachePrefix, type SourceSyncPipeline } from './source-sync.pipeline.js';

export const SOURCE_SYNC_JOB = 'source-sync';
const FILE_SYNC_LEASE_MS = 5 * 60_000;

export interface SourceServiceDeps {
  sources: SourceRepository;
  catalog: CatalogRepository;
  secrets: SourceSecrets;
  pipeline: SourceSyncPipeline;
  fileParser: PlaylistFileParser;
  /** Verifies Xtream credentials before an M3U source is switched to them. */
  xtreamVerifier?: AccountVerifier;
  epg: CatalogEpgLinker;
  jobs: JobKicker;
  removalListeners: SourceRemovalListener[];
  urlPolicy: UrlPolicy;
  cache: Cache;
  clock: Clock;
  logger: Logger;
  limits: { maxSourcesPerUser: number };
}

/**
 * Use cases of Settings → Sources: add (URL / file / Xtream), list, rename, re-configure,
 * "Sync now" and remove. Remote sources are synced in the background (the request returns
 * immediately with status "queued"); uploaded files are parsed within the request.
 */
export class SourceService {
  constructor(private readonly deps: SourceServiceDeps) {}

  async list(ownerId: string): Promise<SourceDto[]> {
    const [sources, guides] = await Promise.all([this.deps.sources.listByOwner(ownerId), this.deps.epg.guideSummaries(ownerId)]);
    return sources.map((source) => toSourceDto(source, guides.get(source.id)));
  }

  async get(ownerId: string, sourceId: string): Promise<SourceDto> {
    return this.toDto(await this.requireOwned(ownerId, sourceId));
  }

  /** Records owned by the user (other modules use this to scope catalog reads). */
  async listRecords(ownerId: string): Promise<SourceRecord[]> {
    return this.deps.sources.listByOwner(ownerId);
  }

  async requireOwned(ownerId: string, sourceId: string): Promise<SourceRecord> {
    if (!this.deps.sources.isValidId(sourceId)) throw AppError.notFound('Source');
    const source = await this.deps.sources.findOwned(sourceId, ownerId);
    if (!source) throw AppError.notFound('Source');
    return source;
  }

  async addUrl(ownerId: string, input: { url: URL; name?: string | undefined }): Promise<SourceDto> {
    await this.assertCanCreate(ownerId);
    this.assertUrlAllowed(input.url);
    const credential: SourceCredential = { type: 'm3u_url', url: input.url.href };
    const source = await this.createRemote(ownerId, {
      name: input.name || input.url.hostname,
      type: 'm3u_url',
      origin: { kind: 'url', host: input.url.host },
      credential,
    });
    return this.toDto(source);
  }

  async addXtream(ownerId: string, input: { server: URL; username: string; password: string; name?: string | undefined }): Promise<SourceDto> {
    await this.assertCanCreate(ownerId);
    const server = normalizeXtreamServer(input.server);
    this.assertUrlAllowed(server);
    const source = await this.createRemote(ownerId, {
      name: input.name || server.hostname,
      type: 'xtream',
      origin: { kind: 'xtream', host: server.host, username: input.username },
      credential: { type: 'xtream', server: server.href, username: input.username, password: input.password },
    });
    return this.toDto(source);
  }

  /** Parses an uploaded playlist in-request (there is nothing to download later). */
  async addFile(ownerId: string, input: { fileName: string; bytes: Buffer; name?: string | undefined }): Promise<SourceDto> {
    await this.assertCanCreate(ownerId);
    const build = this.parseFile(input.bytes, input.fileName);
    const now = this.deps.clock.now();
    const created = await this.deps.sources.create({
      id: this.deps.sources.newId(),
      ownerId,
      name: (input.name || stripExtension(input.fileName) || 'My playlist').slice(0, 80),
      type: 'm3u_file',
      origin: { kind: 'file', fileName: input.fileName },
      credential: null,
      sync: initialSync(false, now, 'running'),
    });
    return this.syncFileNow(created, build, input.fileName);
  }

  /** Replaces the playlist of a file source (new revision, keys stay stable). */
  async replaceFile(ownerId: string, sourceId: string, input: { fileName: string; bytes: Buffer }): Promise<SourceDto> {
    const source = await this.requireOwned(ownerId, sourceId);
    if (source.type !== 'm3u_file') throw new AppError('SOURCE_NOT_SYNCABLE', 409, 'Only file sources can be replaced with a new file.');
    const build = this.parseFile(input.bytes, input.fileName);
    return this.syncFileNow(source, build, input.fileName);
  }

  async update(ownerId: string, sourceId: string, patch: UpdateSourceRequest): Promise<SourceDto> {
    const source = await this.requireOwned(ownerId, sourceId);
    const now = this.deps.clock.now();
    const autoSync = patch.autoSync ?? source.sync.autoSync;
    const intervalHours = patch.intervalHours !== undefined ? clampInterval(patch.intervalHours) : source.sync.intervalHours;

    let credential: string | undefined;
    let origin: SourceOrigin | undefined;
    if (patch.url !== undefined) {
      if (source.type !== 'm3u_url') throw AppError.validation('Only M3U URL sources have a playlist URL.');
      const url = new URL(patch.url);
      this.assertUrlAllowed(url);
      credential = this.deps.secrets.sealCredential({ type: 'm3u_url', url: url.href });
      origin = { kind: 'url', host: url.host };
    }
    if (patch.xtream !== undefined) {
      if (source.type !== 'xtream') throw AppError.validation('Only Xtream sources have Xtream credentials.');
      const server = normalizeXtreamServer(new URL(patch.xtream.server));
      this.assertUrlAllowed(server);
      credential = this.deps.secrets.sealCredential({ type: 'xtream', server: server.href, username: patch.xtream.username, password: patch.xtream.password });
      origin = { kind: 'xtream', host: server.host, username: patch.xtream.username };
    }

    const scheduleChanged = patch.autoSync !== undefined || patch.intervalHours !== undefined;
    const updated = await this.deps.sources.updateSettings(source.id, ownerId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.autoSync !== undefined ? { autoSync } : {}),
      ...(patch.intervalHours !== undefined ? { intervalHours } : {}),
      ...(scheduleChanged ? { nextSyncAt: nextSyncAt({ type: source.type, autoSync, intervalHours, now, consecutiveFailures: 0 }) } : {}),
      ...(credential ? { credential, origin } : {}),
    });
    if (!updated) throw AppError.notFound('Source');

    // New location/credentials: verify right away instead of at the next scheduled sync.
    if (credential) return this.syncNow(ownerId, sourceId);
    return this.toDto(updated);
  }

  /**
   * M3U link of an Xtream panel (`get.php?username=…&password=…`) → Xtream API source: same
   * account, but Movies/Series metadata, account status and archive. Live and movie keys are
   * computed exactly like the M3U import, so favourites, history and progress carry over.
   */
  async convertToXtream(ownerId: string, sourceId: string): Promise<SourceDto> {
    const source = await this.requireOwned(ownerId, sourceId);
    if (source.type !== 'm3u_url') throw new AppError('CONFLICT', 409, 'Only M3U URL sources can be converted to Xtream.');
    const credential = this.deps.secrets.openCredential(source.credential);
    const account = credential.type === 'm3u_url' ? parseXtreamPlaylistUrl(credential.url) : null;
    if (!account) {
      throw new AppError('CONFLICT', 409, 'This playlist link is not an Xtream Codes link (…/get.php?username=…&password=…).');
    }
    const server = normalizeXtreamServer(new URL(account.server));
    this.assertUrlAllowed(server);
    const xtream: SourceCredential = { type: 'xtream', server: server.href, username: account.username, password: account.password };
    // The M3U link is replaced (there is no way back), so the API must work on this panel first:
    // some resellers serve get.php but block player_api.php.
    await this.verifyXtream(xtream);
    const updated = await this.deps.sources.updateSettings(source.id, ownerId, {
      ifType: 'm3u_url',
      type: 'xtream',
      xtreamCandidate: false,
      credential: this.deps.secrets.sealCredential(xtream),
      origin: { kind: 'xtream', host: server.host, username: account.username },
    });
    if (!updated) throw new AppError('CONFLICT', 409, 'This source was changed meanwhile. Reload and try again.');
    this.deps.logger.info({ sourceId: source.id }, 'Source converted from M3U to Xtream');
    return this.syncNow(ownerId, sourceId);
  }

  async syncNow(ownerId: string, sourceId: string): Promise<SourceDto> {
    const source = await this.requireOwned(ownerId, sourceId);
    if (!isSyncable(source.type)) {
      throw new AppError('SOURCE_NOT_SYNCABLE', 409, 'Uploaded playlists cannot be synced. Upload the file again to update it.');
    }
    const queued = await this.deps.sources.requestSync(source.id, this.deps.clock.now());
    this.deps.jobs.kick(SOURCE_SYNC_JOB);
    return this.toDto(queued ?? source);
  }

  async remove(ownerId: string, sourceId: string): Promise<void> {
    const source = await this.requireOwned(ownerId, sourceId);
    if (!(await this.deps.sources.deleteOwned(source.id, ownerId))) throw AppError.notFound('Source');
    await this.deps.catalog.deleteSource(source.id);
    this.deps.cache.deleteByPrefix(sourceCachePrefix(source.id));
    for (const listener of this.deps.removalListeners) {
      await listener.onSourceRemoved(ownerId, source.id).catch((error: unknown) =>
        this.deps.logger.warn({ err: error, sourceId }, 'Source removal cleanup failed'),
      );
    }
  }

  // ---------------------------------------------------------------------------------------

  private async createRemote(
    ownerId: string,
    input: { name: string; type: 'm3u_url' | 'xtream'; origin: SourceOrigin; credential: SourceCredential },
  ): Promise<SourceRecord> {
    const now = this.deps.clock.now();
    const created = await this.deps.sources.create({
      id: this.deps.sources.newId(),
      ownerId,
      name: input.name.slice(0, 80),
      type: input.type,
      origin: input.origin,
      credential: this.deps.secrets.sealCredential(input.credential),
      sync: initialSync(true, now, 'queued'),
    });
    this.deps.jobs.kick(SOURCE_SYNC_JOB);
    this.deps.logger.info({ sourceId: created.id, type: input.type }, 'Source added');
    return created;
  }

  private async syncFileNow(source: SourceRecord, build: ReturnType<PlaylistFileParser['parseFile']>, fileName: string): Promise<SourceDto> {
    const owner = `upload:${randomUUID()}`;
    const now = this.deps.clock.now();
    const claimed = await this.deps.sources.claim(source.id, now, owner, new Date(now.getTime() + FILE_SYNC_LEASE_MS));
    if (!claimed) throw new AppError('SOURCE_BUSY', 409, 'This source is being updated right now. Try again in a moment.');
    if (claimed.origin.kind === 'file' && claimed.origin.fileName !== fileName) {
      await this.deps.sources.updateSettings(source.id, source.ownerId, { origin: { kind: 'file', fileName } });
    }
    const result = await this.deps.pipeline.run({ ...claimed, origin: { kind: 'file', fileName } }, { owner, signal: new AbortController().signal }, build);
    const current = result ?? (await this.deps.sources.findById(source.id));
    if (!current) throw AppError.notFound('Source');
    if (current.sync.status === 'failed' && current.revision === 0) {
      // A brand-new file that cannot be used is not kept around as a broken source.
      await this.deps.sources.deleteOwned(current.id, current.ownerId);
      await this.deps.catalog.deleteSource(current.id);
      throw new AppError(current.sync.error?.problem === 'empty' ? 'SOURCE_EMPTY' : 'SOURCE_INVALID', 422, current.sync.error?.message ?? 'The playlist could not be read.');
    }
    return this.toDto(current);
  }

  private parseFile(bytes: Buffer, fileName: string) {
    try {
      return this.deps.fileParser.parseFile(bytes, fileName);
    } catch (error) {
      if (error instanceof SourceFetchError) {
        throw new AppError(error.problem === 'empty' ? 'SOURCE_EMPTY' : 'SOURCE_INVALID', 422, error.message, error.details);
      }
      const { message } = classifyFailure(error);
      throw new AppError('SOURCE_INVALID', 422, message);
    }
  }

  private async verifyXtream(credential: SourceCredential): Promise<void> {
    if (!this.deps.xtreamVerifier) return;
    try {
      await this.deps.xtreamVerifier.verifyAccount(credential, AbortSignal.timeout(30_000));
    } catch (error) {
      const { problem, message } = classifyFailure(error);
      const code = problem === 'auth_failed' ? 'SOURCE_AUTH_FAILED' : problem === 'expired' ? 'SOURCE_EXPIRED' : problem === 'blocked' ? 'UPSTREAM_BLOCKED' : 'SOURCE_UNAVAILABLE';
      throw new AppError(code, 422, `The Xtream API of this panel cannot be used: ${message} The playlist link was kept.`);
    }
  }

  private async toDto(source: SourceRecord): Promise<SourceDto> {
    const guides = await this.deps.epg.guideSummaries(source.ownerId);
    return toSourceDto(source, guides.get(source.id));
  }

  private assertUrlAllowed(url: URL): void {
    try {
      this.deps.urlPolicy.assertAllowed(url);
    } catch {
      throw new AppError('UPSTREAM_BLOCKED', 422, 'This URL points to a private or local network address and cannot be used.');
    }
  }

  private async assertCanCreate(ownerId: string): Promise<void> {
    const limit = this.deps.limits.maxSourcesPerUser;
    if ((await this.deps.sources.countByOwner(ownerId)) >= limit) {
      throw new AppError('SOURCE_LIMIT_REACHED', 409, `You can keep up to ${limit} sources. Remove one to add another.`);
    }
  }
}

function initialSync(autoSync: boolean, now: Date, status: 'queued' | 'running'): SourceSyncState {
  return {
    status,
    stage: status === 'running' ? 'parsing' : null,
    autoSync,
    intervalHours: DEFAULT_SYNC_INTERVAL_HOURS,
    lastAttemptAt: status === 'running' ? now : null,
    lastSuccessAt: null,
    nextSyncAt: status === 'queued' ? now : null,
    error: null,
    consecutiveFailures: 0,
    rerunRequested: false,
  };
}

/** `http://host:8080/player_api.php?…` or `http://host:8080/` → `http://host:8080/`. */
export function normalizeXtreamServer(input: URL): URL {
  const url = new URL(input.href);
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  url.pathname = url.pathname.replace(/\/(?:player_api|get|xmltv|panel_api)\.php$/i, '/').replace(/\/+$/, '/') || '/';
  return url;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.(m3u8?|pls|txt)$/i, '').trim();
}
