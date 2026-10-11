import type { PageDto, StreamKind, UnplayableReason } from './common';

// ---------------------------------------------------------------------------
// Live TV
// ---------------------------------------------------------------------------

export interface ChannelDto {
  /** Stable across syncs as long as name/group don't change. URL-safe. */
  key: string;
  name: string;
  /**
   * Group labels as found in the source (`group-title`, `#EXTGRP`, Xtream category). Empty when the
   * entry has no group. `;`-separated multi-groups are split, as Kodi/iptv-org do.
   */
  groups: string[];
  logo: string | null;
  tvgId: string | null;
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  /** Archive (catch-up) depth in days; null when the channel has no archive. */
  catchupDays: number | null;
  /** Linked to a programme guide (now/next available). */
  hasEpg: boolean;
  /** Requires the parental PIN to play. */
  locked: boolean;
}

export interface ChannelListDto {
  sourceId: string;
  catalogVersion: string;
  channels: ChannelDto[];
}

// ---------------------------------------------------------------------------
// Movies & Series (VOD)
// ---------------------------------------------------------------------------

export interface VodCategoryDto {
  name: string;
  count: number;
}

export interface MovieDto {
  sourceId: string;
  key: string;
  name: string;
  year: number | null;
  poster: string | null;
  /** 0–10. */
  rating: number | null;
  genres: string[];
  /** Provider categories. */
  groups: string[];
  durationSecs: number | null;
  /** When the provider added it (or when ZIPTV first saw it). */
  addedAt: string | null;
  locked: boolean;
}

export interface MovieDetailsDto extends MovieDto {
  plot: string | null;
  cast: string[];
  director: string | null;
  backdrop: string | null;
  releaseDate: string | null;
  trailerUrl: string | null;
  inMyList: boolean;
  progress: ProgressStateDto | null;
}

export interface SeriesDto {
  sourceId: string;
  key: string;
  name: string;
  year: number | null;
  cover: string | null;
  rating: number | null;
  genres: string[];
  groups: string[];
  addedAt: string | null;
  locked: boolean;
}

export interface ProgressStateDto {
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: string;
}

export interface EpisodeDto {
  key: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  durationSecs: number | null;
  still: string | null;
  airDate: string | null;
  progress: ProgressStateDto | null;
}

export interface SeasonDto {
  number: number;
  name: string;
  cover: string | null;
  episodes: EpisodeDto[];
}

export interface SeriesDetailsDto extends SeriesDto {
  plot: string | null;
  cast: string[];
  director: string | null;
  backdrop: string | null;
  seasons: SeasonDto[];
  inMyList: boolean;
  /** Where "Continue watching" / "Play" should start. */
  resume: {
    episodeKey: string;
    season: number;
    episode: number;
    title: string;
    position: number;
    duration: number;
    remainingSecs: number;
  } | null;
}

export type VodSort = 'recent' | 'name' | 'rating' | 'year';

export type MoviePageDto = PageDto<MovieDto>;
export type SeriesPageDto = PageDto<SeriesDto>;

/** Movies home: a few rails (Trending/Recently added/per category). */
export interface VodRailDto<T> {
  id: string;
  title: string;
  /** Category the rail represents (for "See all"); null for computed rails. */
  category: string | null;
  items: T[];
}

export interface VodOverviewDto<T> {
  sourceId: string;
  categories: VodCategoryDto[];
  rails: VodRailDto<T>[];
}
