import { AppError } from '../errors.js';
import type { Cache } from '../ports/cache.js';
import { SourceFetchError } from '../ports/catalog-provider.js';
import type { CatalogRepository, StoredEpisode, StoredSeries } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { SeriesDetailsSource } from '../ports/series-details-source.js';
import type { SourceRecord } from '../ports/source-repository.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';

/** A series the provider reported without episodes is asked again after this long. */
export const EMPTY_SERIES_RETRY_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface SeriesEpisodesDeps {
  catalog: CatalogRepository;
  secrets: SourceSecrets;
  details?: SeriesDetailsSource;
  cache: Cache;
  clock: Clock;
  logger: Logger;
}

/**
 * Episodes of a series. M3U sources carry them in the revision; Xtream series are fetched from
 * the provider the first time someone opens or plays them, then stored in the same revision —
 * so the "cache" lives exactly as long as the catalog revision and is refreshed by every sync.
 *
 * Concurrent opens of one series share a single upstream call on this instance; another
 * instance fetching at the same moment is harmless (idempotent insert).
 */
export class SeriesEpisodes {
  constructor(private readonly deps: SeriesEpisodesDeps) {}

  async list(source: SourceRecord, series: StoredSeries): Promise<StoredEpisode[]> {
    const pin = { sourceId: source.id, revision: source.revision };
    const stored = await this.deps.catalog.listEpisodes(pin, series.key);
    if (stored.length > 0 || !series.xtream || !this.deps.details) return stored;

    const fetchedAt = series.detailsFetchedAt?.getTime();
    if (fetchedAt !== undefined && this.deps.clock.now().getTime() - fetchedAt < EMPTY_SERIES_RETRY_MS) return stored;

    const xtreamId = series.xtream.id;
    const key = `${sourceCachePrefix(source.id)}series-details:${source.revision}:${series.key}`;
    // Short TTL: the cache only joins concurrent callers; the database is the real store.
    return this.deps.cache.wrap(key, 5_000, () => this.fetchAndStore(source, series.key, xtreamId));
  }

  /** Fetched episodes, in the same order as `listEpisodes` (season, episode). */
  private async fetchAndStore(source: SourceRecord, seriesKey: string, xtreamId: number): Promise<StoredEpisode[]> {
    const details = this.deps.details;
    if (!details) return [];
    let result;
    try {
      result = await details.fetchSeriesDetails(this.deps.secrets.openCredential(source.credential), { key: seriesKey, xtreamId }, AbortSignal.timeout(FETCH_TIMEOUT_MS));
    } catch (error) {
      this.deps.logger.warn({ err: error, sourceId: source.id, seriesKey }, 'Fetching series episodes failed');
      throw toAppError(error);
    }
    const episodes: StoredEpisode[] = result.episodes.map((episode) => ({ ...episode, locator: this.deps.secrets.sealLocator(episode.locator) }));
    const stored = await this.deps.catalog.storeSeriesDetails({ sourceId: source.id, revision: source.revision }, seriesKey, { episodes, plot: result.plot }, this.deps.clock.now());
    // Not stored = a sync replaced this revision meanwhile. The episodes are still the provider's
    // current ones, so they are served anyway; the new revision fetches its own on next open.
    if (!stored) this.deps.logger.info({ sourceId: source.id, seriesKey }, 'Series revision replaced while loading episodes; not stored');
    return episodes;
  }
}

function toAppError(error: unknown): AppError {
  if (error instanceof SourceFetchError) {
    switch (error.problem) {
      case 'auth_failed':
        return new AppError('SOURCE_AUTH_FAILED', 502, 'The provider rejected the account while loading episodes. Check the source in Settings → Sources.');
      case 'expired':
        return new AppError('SOURCE_EXPIRED', 502, 'The provider no longer knows this series or the subscription has expired.');
      case 'blocked':
        return new AppError('UPSTREAM_BLOCKED', 422, error.message);
      default:
        return new AppError('SOURCE_UNAVAILABLE', 502, 'The provider did not return the episodes. Try again in a moment.');
    }
  }
  return new AppError('SOURCE_UNAVAILABLE', 502, 'The provider did not return the episodes. Try again in a moment.', undefined, { cause: error });
}
