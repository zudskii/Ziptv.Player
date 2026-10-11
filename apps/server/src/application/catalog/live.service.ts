import type { ChannelDto, ChannelListDto } from '@ziptv/contracts';

import { AppError } from '../errors.js';
import { isHiddenForViewer, isLockedForViewer, type Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository, LiveChannelSummary } from '../ports/catalog-repository.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import { catalogVersion } from '../sources/source-mapper.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';
import { toChannelDto } from './catalog-mapper.js';

const LIST_TTL_MS = 10 * 60_000;

/** Live TV catalog reads: channel lists (per source), single channels, visibility rules. */
export class LiveCatalogService {
  constructor(
    private readonly deps: {
      sources: SourceRepository;
      catalog: CatalogRepository;
      cache: Cache;
    },
  ) {}

  async requireSource(viewer: Viewer, sourceId: string): Promise<SourceRecord> {
    if (!this.deps.sources.isValidId(sourceId)) throw AppError.notFound('Source');
    const source = await this.deps.sources.findOwned(sourceId, viewer.userId);
    if (!source) throw AppError.notFound('Source');
    return source;
  }

  /** Strong validator for the channel list (catalog + viewer restrictions). */
  async listVersion(viewer: Viewer, sourceId: string): Promise<string> {
    const source = await this.requireSource(viewer, sourceId);
    return `${catalogVersion(source)}.${viewer.restrictionsVersion}${viewer.unlocked ? 'u' : ''}`;
  }

  async listChannels(viewer: Viewer, sourceId: string): Promise<ChannelListDto> {
    const source = await this.requireSource(viewer, sourceId);
    const channels = await this.summaries(source);
    return {
      sourceId: source.id,
      catalogVersion: catalogVersion(source),
      channels: this.visible(viewer, source.id, channels),
    };
  }

  async getChannel(viewer: Viewer, sourceId: string, key: string): Promise<ChannelDto> {
    const source = await this.requireSource(viewer, sourceId);
    const [channel] = await this.deps.catalog.findLiveMany({ sourceId: source.id, revision: source.revision }, [key]);
    if (!channel || isHiddenForViewer(viewer, channel)) throw AppError.notFound('Channel');
    return toChannelDto(channel, this.isLocked(viewer, source.id, channel));
  }

  /** Cached raw summaries of the current revision (shared by every profile of the user). */
  async summaries(source: SourceRecord): Promise<LiveChannelSummary[]> {
    return this.deps.cache.wrap(`${sourceCachePrefix(source.id)}live:${catalogVersion(source)}`, LIST_TTL_MS, () =>
      this.deps.catalog.listLive({ sourceId: source.id, revision: source.revision }),
    );
  }

  visible(viewer: Viewer, sourceId: string, channels: LiveChannelSummary[]): ChannelDto[] {
    const result: ChannelDto[] = [];
    for (const channel of channels) {
      if (isHiddenForViewer(viewer, channel)) continue;
      const locked = this.isLocked(viewer, sourceId, channel);
      if (locked && viewer.kids) continue;
      result.push(toChannelDto(channel, locked));
    }
    return result;
  }

  isLocked(viewer: Viewer, sourceId: string, channel: { key: string; groups: readonly string[] }): boolean {
    return !viewer.unlocked && isLockedForViewer(viewer, sourceId, channel);
  }
}
