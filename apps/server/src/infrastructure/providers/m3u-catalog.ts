import { isAdultEntry } from '../../domain/catalog/adult.js';
import { parseCatchup } from '../../domain/catalog/catchup.js';
import { classifyEntry, extractYear, type EpisodeName } from '../../domain/catalog/classify.js';
import { createContentKeyFactory, episodeKey } from '../../domain/catalog/content-key.js';
import type { CatalogBuild, EpisodeEntry, LiveChannelEntry, MovieEntry, SeriesEntry } from '../../domain/catalog/model.js';
import type { ParsedChannel, ParsedPlaylist } from '../parsers/m3u/index.js';

/**
 * Turns a parsed M3U into the catalog model: Live TV, Movies and Series → Season → Episode.
 *
 * Keys of live channels are exactly the 2.x channel keys (computed by the parser over the
 * whole list), so favourites/history from 2.x keep pointing at the same channels.
 */
export function buildCatalogFromPlaylist(parsed: ParsedPlaylist): CatalogBuild {
  const live: LiveChannelEntry[] = [];
  const movies: MovieEntry[] = [];
  const seriesByIdentity = new Map<string, SeriesEntry>();
  const episodes: EpisodeEntry[] = [];
  const seriesKeys = createContentKeyFactory();
  const usedEpisodeKeys = new Set<string>();

  for (const channel of parsed.channels) {
    const url = safeUrl(channel.url);
    const classification = channel.unplayableReason ? { kind: 'live' as const, episode: null } : classifyEntry({ url, name: channel.name, duration: channel.duration, attributes: channel.attributes });
    const locator = { url: channel.url, headers: channel.headers };
    const adult = isAdultEntry(channel);

    switch (classification.kind) {
      case 'live':
        live.push({
          key: channel.key,
          position: live.length,
          name: channel.name,
          groups: channel.groups,
          logo: channel.logo,
          tvgId: channel.tvgId,
          tvgName: channel.tvgName,
          kind: channel.kind,
          unplayableReason: channel.unplayableReason,
          locator,
          catchup: parseCatchup(channel.attributes, parsed.headerAttributes),
          adult,
          xtream: null,
          addedAt: null,
          epg: null,
        });
        break;
      case 'movie': {
        const { title, year } = extractYear(channel.name);
        movies.push({
          key: channel.key,
          position: movies.length,
          name: title,
          year,
          groups: channel.groups,
          poster: channel.logo,
          rating: parseRating(channel.attributes['rating'] ?? channel.attributes['tvg-rating']),
          genres: splitList(channel.attributes['genre'] ?? channel.attributes['tvg-genre']),
          durationSecs: channel.duration > 0 ? Math.round(channel.duration) : null,
          plot: channel.attributes['description'] ?? channel.attributes['tvg-description'] ?? null,
          kind: channel.kind,
          locator,
          adult,
          xtream: null,
          addedAt: null,
        });
        break;
      }
      case 'episode': {
        const info = classification.episode as EpisodeName;
        const identity = `${info.seriesName.toLowerCase()}\u0000${channel.groups.map((g) => g.toLowerCase()).join(';')}`;
        let series = seriesByIdentity.get(identity);
        if (!series) {
          const { title, year } = extractYear(info.seriesName);
          series = {
            key: seriesKeys({ name: info.seriesName, groups: channel.groups }),
            position: seriesByIdentity.size,
            name: title,
            year,
            groups: channel.groups,
            cover: channel.logo,
            rating: null,
            genres: [],
            plot: null,
            adult,
            xtream: null,
            addedAt: null,
          };
          seriesByIdentity.set(identity, series);
        }
        episodes.push(toEpisode(channel, series.key, info, usedEpisodeKeys, locator));
        break;
      }
    }
  }

  return {
    live,
    movies,
    series: [...seriesByIdentity.values()],
    episodes,
    epgUrls: parsed.epgUrls,
    format: parsed.format,
    encoding: parsed.encoding,
    warnings: parsed.warnings,
    warningCount: parsed.warningCount,
    truncated: parsed.truncated,
    account: null,
    xtreamCandidate: false,
  };
}

function toEpisode(
  channel: ParsedChannel,
  seriesKey: string,
  info: EpisodeName,
  used: Set<string>,
  locator: { url: string; headers: ParsedChannel['headers'] },
): EpisodeEntry {
  let key = episodeKey(seriesKey, info.season, info.episode);
  for (let n = 2; used.has(key); n++) key = `${episodeKey(seriesKey, info.season, info.episode)}-${n}`;
  used.add(key);
  return {
    key,
    seriesKey,
    season: info.season,
    episode: info.episode,
    title: info.title || `Episode ${info.episode}`,
    plot: null,
    durationSecs: channel.duration > 0 ? Math.round(channel.duration) : null,
    still: null,
    airDate: null,
    kind: channel.kind,
    locator,
    xtream: null,
  };
}

/** `get.php?username=…&password=…` is the Xtream Codes playlist endpoint. */
export function isXtreamPlaylistUrl(url: URL): boolean {
  return /\/get\.php$/i.test(url.pathname) && url.searchParams.has('username') && url.searchParams.has('password');
}

function parseRating(value: string | undefined): number | null {
  if (!value) return null;
  const rating = Number.parseFloat(value);
  if (!Number.isFinite(rating) || rating <= 0) return null;
  return Math.min(10, rating > 10 ? rating / 10 : rating);
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,/|;]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
