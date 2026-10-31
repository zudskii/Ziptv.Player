import type { ChannelDto, MovieDto, SeriesDto } from '@ziptv/contracts';

import type { LiveChannelSummary, MovieSummary, SeriesSummary } from '../ports/catalog-repository.js';
import { directArtwork, type ArtworkUrls } from './artwork.js';

export function toChannelDto(channel: LiveChannelSummary, locked: boolean, artwork: ArtworkUrls = directArtwork): ChannelDto {
  return {
    key: channel.key,
    name: channel.name,
    groups: channel.groups,
    logo: artwork.url(channel.logo),
    tvgId: channel.tvgId,
    kind: channel.kind,
    unplayableReason: channel.unplayableReason,
    catchupDays: channel.catchup?.days ?? null,
    hasEpg: channel.epg !== null,
    locked,
  };
}

export function toMovieDto(sourceId: string, movie: MovieSummary, locked: boolean, artwork: ArtworkUrls = directArtwork): MovieDto {
  return {
    sourceId,
    key: movie.key,
    name: movie.name,
    year: movie.year,
    poster: artwork.url(movie.poster),
    rating: movie.rating,
    genres: movie.genres,
    groups: movie.groups,
    durationSecs: movie.durationSecs,
    addedAt: movie.addedAt?.toISOString() ?? null,
    locked,
  };
}

export function toSeriesDto(sourceId: string, series: SeriesSummary, locked: boolean, artwork: ArtworkUrls = directArtwork): SeriesDto {
  return {
    sourceId,
    key: series.key,
    name: series.name,
    year: series.year,
    cover: artwork.url(series.cover),
    rating: series.rating,
    genres: series.genres,
    groups: series.groups,
    addedAt: series.addedAt?.toISOString() ?? null,
    locked,
  };
}
