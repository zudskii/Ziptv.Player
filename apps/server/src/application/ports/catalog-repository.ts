import type { EpgLink, EpisodeEntry, LiveChannelEntry, MovieEntry, SeriesEntry } from '../../domain/catalog/model.js';

/** Stored forms: locators are encrypted strings, plus search/match keys computed at sync time. */
export interface StoredLiveChannel extends Omit<LiveChannelEntry, 'locator'> {
  locator: string | null;
  /** `normalizeChannelName(name)` — EPG name matching and "same channel in another source". */
  nameKey: string;
  searchTokens: string[];
}

export interface StoredMovie extends Omit<MovieEntry, 'locator'> {
  locator: string | null;
  searchTokens: string[];
}

export interface StoredSeries extends SeriesEntry {
  searchTokens: string[];
}

export interface StoredEpisode extends Omit<EpisodeEntry, 'locator'> {
  locator: string | null;
}

export type LiveChannelSummary = Omit<StoredLiveChannel, 'locator' | 'searchTokens' | 'tvgName'>;

/** Reference to a source at a given revision (catalog reads always pin a revision). */
export interface SourceRevisionRef {
  sourceId: string;
  revision: number;
}

export interface LiveLinkTarget {
  key: string;
  name: string;
  nameKey: string;
  tvgId: string | null;
  xtreamEpgId: string | null;
  epg: EpgLink | null;
}

export interface RevisionData {
  live: StoredLiveChannel[];
  movies: StoredMovie[];
  series: StoredSeries[];
  episodes: StoredEpisode[];
}

export interface AddedAtIndex {
  live: Map<string, Date | null>;
  movies: Map<string, Date | null>;
  series: Map<string, Date | null>;
}

export interface CatalogRepository {
  insertRevision(sourceId: string, revision: number, data: RevisionData): Promise<void>;
  deleteRevision(sourceId: string, revision: number): Promise<void>;
  deleteOtherRevisions(sourceId: string, keepRevision: number): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
  /** key → addedAt of a revision, to carry "first seen" dates into the next one. */
  addedAtIndex(sourceId: string, revision: number): Promise<AddedAtIndex>;

  // --- live -------------------------------------------------------------------------------
  listLive(ref: SourceRevisionRef): Promise<LiveChannelSummary[]>;
  findLive(ref: SourceRevisionRef, key: string): Promise<StoredLiveChannel | null>;
  findLiveMany(ref: SourceRevisionRef, keys: string[]): Promise<LiveChannelSummary[]>;
  /** Channels with the same normalised name in other sources ("Try alternate stream"). */
  findLiveByNameKey(refs: SourceRevisionRef[], nameKey: string, limit: number): Promise<(LiveChannelSummary & { sourceId: string })[]>;
  liveLinkTargets(ref: SourceRevisionRef): Promise<LiveLinkTarget[]>;
  setLiveEpgLinks(ref: SourceRevisionRef, changes: { key: string; epg: EpgLink | null }[]): Promise<void>;

  // --- VOD --------------------------------------------------------------------------------
  findMovie(ref: SourceRevisionRef, key: string): Promise<StoredMovie | null>;
  findSeries(ref: SourceRevisionRef, key: string): Promise<StoredSeries | null>;
  findEpisode(ref: SourceRevisionRef, seriesKey: string, key: string): Promise<StoredEpisode | null>;
  listEpisodes(ref: SourceRevisionRef, seriesKey: string): Promise<StoredEpisode[]>;
}
