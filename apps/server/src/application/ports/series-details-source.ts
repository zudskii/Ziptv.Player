import type { EpisodeEntry } from '../../domain/catalog/model.js';
import type { SourceCredential } from '../../domain/sources/source.js';

export interface SeriesDetails {
  episodes: EpisodeEntry[];
  plot: string | null;
}

/**
 * Episodes of one series of a provider-API source (Xtream `get_series_info`), read on demand:
 * fetching every series during a sync would cost one upstream call per series.
 */
export interface SeriesDetailsSource {
  fetchSeriesDetails(credential: SourceCredential, series: { key: string; xtreamId: number }, signal: AbortSignal): Promise<SeriesDetails>;
}
