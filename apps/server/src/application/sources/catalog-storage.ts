import type { CatalogBuild } from '../../domain/catalog/model.js';
import { normalizeChannelName, searchTokens } from '../../domain/shared/text.js';
import type { RevisionData } from '../ports/catalog-repository.js';
import type { SourceSecrets } from './secrets.js';

/** Catalog build → stored revision: locators sealed, search/match keys computed once. */
export function toStoredRevision(build: Pick<CatalogBuild, 'live' | 'movies' | 'series' | 'episodes'>, secrets: SourceSecrets): RevisionData {
  return {
    live: build.live.map((channel) => ({
      ...channel,
      locator: secrets.sealLocator(channel.locator),
      nameKey: normalizeChannelName(channel.name),
      searchTokens: searchTokens(channel.name, channel.tvgName),
    })),
    movies: build.movies.map((movie) => ({
      ...movie,
      locator: secrets.sealLocator(movie.locator),
      searchTokens: searchTokens(movie.name, movie.year ? String(movie.year) : null),
    })),
    series: build.series.map((series) => ({ ...series, detailsFetchedAt: null, searchTokens: searchTokens(series.name, series.year ? String(series.year) : null) })),
    episodes: build.episodes.map((episode) => ({ ...episode, locator: secrets.sealLocator(episode.locator) })),
  };
}
