/**
 * Per-profile user state: My List, progress (Continue Watching) and watch history.
 * Rows are keyed by stable catalog keys; `sourceId` cascades on source removal.
 */

export type ListItemKind = 'channel' | 'movie' | 'series';
export type ProgressKind = 'movie' | 'episode';
export type HistoryKind = 'channel' | 'movie' | 'episode' | 'catchup';

export interface ListItemRecord {
  profileId: string;
  sourceId: string;
  type: ListItemKind;
  key: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  addedAt: Date;
}

export interface ProgressRecord {
  profileId: string;
  sourceId: string;
  contentType: ProgressKind;
  /** '' for movies. */
  seriesKey: string;
  key: string;
  season: number | null;
  episode: number | null;
  title: string;
  seriesTitle: string | null;
  image: string | null;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: Date;
}

export interface HistoryRecord {
  id: string;
  profileId: string;
  sourceId: string;
  contentType: HistoryKind;
  key: string;
  seriesKey: string | null;
  season: number | null;
  episode: number | null;
  title: string;
  subtitle: string | null;
  seriesTitle: string | null;
  image: string | null;
  startedAt: Date;
  watchedAt: Date;
  watchedSecs: number;
  programmeStart: Date | null;
  programmeEnd: Date | null;
}

export interface ProgressRef {
  profileId: string;
  sourceId: string;
  contentType: ProgressKind;
  seriesKey: string;
  key: string;
}

export interface ListRepository {
  add(item: Omit<ListItemRecord, 'addedAt'>): Promise<ListItemRecord>;
  remove(profileId: string, sourceId: string, type: ListItemKind, key: string): Promise<boolean>;
  list(profileId: string, limit: number): Promise<ListItemRecord[]>;
  /** Keys of one type in one source that are on the list (marks cards / details). */
  keys(profileId: string, sourceId: string, type: ListItemKind): Promise<Set<string>>;
  clear(profileId: string): Promise<number>;
  count(profileId: string): Promise<number>;
}

export interface ProgressRepository {
  find(ref: ProgressRef): Promise<ProgressRecord | null>;
  save(record: Omit<ProgressRecord, 'updatedAt'>, now: Date): Promise<void>;
  /** Unfinished items, most recent first. */
  listRecent(profileId: string, limit: number): Promise<ProgressRecord[]>;
  listForSeries(profileId: string, sourceId: string, seriesKey: string): Promise<ProgressRecord[]>;
  /** Progress of several movies of one source (cards). */
  listForMovies(profileId: string, sourceId: string, keys: string[]): Promise<ProgressRecord[]>;
  remove(ref: ProgressRef): Promise<boolean>;
  clear(profileId: string): Promise<number>;
  count(profileId: string): Promise<number>;
}

export interface HistoryPageQuery {
  limit: number;
  /** Rows strictly older than this cursor (watchedAt, id). */
  before?: { watchedAt: Date; id: string };
  minSecs: number;
}

export interface HistoryRepository {
  /** Records a viewing (idempotent per id = playback session). `initialSecs`: imported viewings. */
  start(record: Omit<HistoryRecord, 'startedAt' | 'watchedAt' | 'watchedSecs'>, now: Date, initialSecs?: number): Promise<void>;
  /** Heartbeat: credits time since the last activity (capped) and returns the row. */
  touch(id: string, profileId: string, now: Date, maxCreditSecs: number): Promise<HistoryRecord | null>;
  find(id: string, profileId: string): Promise<HistoryRecord | null>;
  page(profileId: string, query: HistoryPageQuery): Promise<HistoryRecord[]>;
  /** Latest viewing per item (Home "Recently watched"). */
  recentDistinct(profileId: string, limit: number, minSecs: number, types?: HistoryKind[]): Promise<HistoryRecord[]>;
  remove(id: string, profileId: string): Promise<boolean>;
  clear(profileId: string): Promise<number>;
  count(profileId: string, minSecs: number): Promise<number>;
  /** Retention: per-profile `data.historyRetentionDays` and abandoned zapping rows. */
  prune(now: Date, defaultRetentionDays: number, minSecs: number): Promise<number>;
}
