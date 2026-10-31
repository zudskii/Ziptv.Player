import type { SearchResultDto } from '@ziptv/contracts';

import { queryTerms } from '../../domain/shared/text.js';
import type { EpgService } from '../epg/epg.service.js';
import type { Viewer } from '../identity/viewer.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { usableSources } from '../user-state/viewer-sources.js';
import { directArtwork, type ArtworkUrls } from './artwork.js';
import { toChannelDto, toMovieDto, toSeriesDto } from './catalog-mapper.js';
import type { LiveCatalogService } from './live.service.js';

const PER_TYPE = 20;
export const MIN_QUERY_LENGTH = 2;

/**
 * Unified search: channels, movies and series of every source (word-prefix match on names,
 * pg_trgm-indexed) plus programmes (on now / upcoming / replayable). Each part fails alone.
 */
export class SearchService {
  constructor(
    private readonly deps: {
      sources: SourceRepository;
      catalog: CatalogRepository;
      live: Pick<LiveCatalogService, 'isLocked'>;
      epg: Pick<EpgService, 'search'>;
      logger: Logger;
      artwork?: ArtworkUrls;
    },
  ) {}

  async search(viewer: Viewer, rawQuery: string): Promise<SearchResultDto> {
    const query = rawQuery.trim().slice(0, 100);
    const terms = queryTerms(query);
    const empty: SearchResultDto = { query, channels: [], movies: [], series: [], programmes: [] };
    if (query.length < MIN_QUERY_LENGTH || terms.length === 0) return empty;

    const artwork = this.deps.artwork ?? directArtwork;
    const { byId, refs } = await usableSources(this.deps.sources, viewer);
    const hideAdult = viewer.kids || viewer.hideAdult;
    const [catalog, programmes] = await Promise.all([
      this.deps.catalog.search(refs, terms, PER_TYPE, hideAdult).catch((error: unknown) => {
        this.deps.logger.warn({ err: error }, 'Catalog search failed');
        return { live: [], movies: [], series: [] };
      }),
      this.deps.epg.search(viewer, query, PER_TYPE).catch((error: unknown) => {
        this.deps.logger.warn({ err: error }, 'Programme search failed');
        return { query, items: [] };
      }),
    ]);
    const locked = (sourceId: string, item: { key: string; groups: readonly string[] }) => this.deps.live.isLocked(viewer, sourceId, item);
    const visible = <T extends { sourceId: string; key: string; groups: string[] }>(item: T) => !(viewer.kids && locked(item.sourceId, item));
    return {
      query,
      channels: catalog.live.filter(visible).map((channel) => ({
        sourceId: channel.sourceId,
        sourceName: byId.get(channel.sourceId)?.name ?? '',
        channel: toChannelDto(channel, locked(channel.sourceId, channel), artwork),
      })),
      movies: catalog.movies.filter(visible).map((movie) => toMovieDto(movie.sourceId, movie, locked(movie.sourceId, movie), artwork)),
      series: catalog.series.filter(visible).map((item) => toSeriesDto(item.sourceId, item, locked(item.sourceId, item), artwork)),
      programmes: programmes.items,
    };
  }
}
