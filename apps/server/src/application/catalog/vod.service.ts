import type { EpisodeDto, SeasonDto, SeriesDetailsDto } from '@ziptv/contracts';

import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { CatalogRepository, StoredEpisode } from '../ports/catalog-repository.js';
import { directArtwork, type ArtworkUrls } from './artwork.js';
import type { LiveCatalogService } from './live.service.js';
import type { SeriesEpisodes } from './series-episodes.js';

/**
 * Movies & Series reads. For now: series details with seasons/episodes (Xtream episodes load
 * on first open). Browsing pages, My List and progress come with the viewer experience phase.
 */
export class VodCatalogService {
  constructor(
    private readonly deps: {
      live: Pick<LiveCatalogService, 'requireSource' | 'isLocked'>;
      catalog: CatalogRepository;
      episodes: Pick<SeriesEpisodes, 'list'>;
      artwork?: ArtworkUrls;
    },
  ) {}

  async seriesDetails(viewer: Viewer, sourceId: string, seriesKey: string): Promise<SeriesDetailsDto> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    if (source.revision === 0) throw AppError.notFound('Series');
    const series = await this.deps.catalog.findSeries({ sourceId: source.id, revision: source.revision }, seriesKey);
    if (!series || isHiddenForViewer(viewer, series)) throw AppError.notFound('Series');
    const artwork = this.deps.artwork ?? directArtwork;
    const episodes = await this.deps.episodes.list(source, series);
    return {
      sourceId: source.id,
      key: series.key,
      name: series.name,
      year: series.year,
      cover: artwork.url(series.cover),
      rating: series.rating,
      genres: series.genres,
      groups: series.groups,
      addedAt: series.addedAt?.toISOString() ?? null,
      locked: this.deps.live.isLocked(viewer, source.id, series),
      plot: series.plot,
      cast: [],
      director: null,
      backdrop: null,
      seasons: toSeasons(episodes, artwork),
      inMyList: false,
      resume: null,
    };
  }
}

export function toSeasons(episodes: readonly StoredEpisode[], artwork: ArtworkUrls): SeasonDto[] {
  const seasons = new Map<number, EpisodeDto[]>();
  for (const episode of episodes) {
    let list = seasons.get(episode.season);
    if (!list) seasons.set(episode.season, (list = []));
    list.push({
      key: episode.key,
      season: episode.season,
      episode: episode.episode,
      title: episode.title,
      plot: episode.plot,
      durationSecs: episode.durationSecs,
      still: artwork.url(episode.still),
      airDate: episode.airDate,
      progress: null,
    });
  }
  return [...seasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, list]) => ({
      number,
      name: number === 0 ? 'Specials' : `Season ${number}`,
      cover: null,
      episodes: list.sort((a, b) => a.episode - b.episode),
    }));
}
