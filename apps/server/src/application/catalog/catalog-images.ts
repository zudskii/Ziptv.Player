import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';

const TTL_MS = 60 * 60_000;

/**
 * Resolves the image URL of a catalog item for the public image proxy. Only images that exist
 * in a stored catalog can be fetched — the proxy never accepts an arbitrary URL.
 */
export class CatalogImages {
  constructor(
    private readonly deps: {
      sources: SourceRepository;
      catalog: CatalogRepository;
      cache: Cache;
    },
  ) {}

  async find(sourceId: string, type: 'channel' | 'movie' | 'series', key: string): Promise<string | null> {
    return this.deps.cache.wrap(`${sourceCachePrefix(sourceId)}image:${type}:${key}`, TTL_MS, async () => {
      const source = await this.deps.sources.findById(sourceId);
      if (!source || source.revision === 0) return null;
      const pin = { sourceId, revision: source.revision };
      switch (type) {
        case 'channel':
          return (await this.deps.catalog.findLiveMany(pin, [key]))[0]?.logo ?? null;
        case 'movie':
          return (await this.deps.catalog.findMovie(pin, key))?.poster ?? null;
        case 'series':
          return (await this.deps.catalog.findSeries(pin, key))?.cover ?? null;
      }
    });
  }
}
