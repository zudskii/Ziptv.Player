/**
 * Splits a flat M3U into Live TV, Movies and Series.
 *
 * Provider playlists (`get.php?type=m3u_plus`) mix everything in one list; ZIPTV keeps VOD out
 * of the channel list. Only strong signals are used — a live channel misfiled as a movie is
 * worse than a movie left in Live TV:
 *  1. explicit attributes (`tvg-type`/`type`),
 *  2. Xtream URL layout (`/movie/…`, `/series/…`),
 *  3. a VOD container extension together with a real duration (`#EXTINF:5400,…`).
 */

export type EntryKind = 'live' | 'movie' | 'episode';

export interface ClassifyInput {
  url: URL | null;
  name: string;
  duration: number;
  attributes: Record<string, string>;
}

export interface EpisodeName {
  seriesName: string;
  season: number;
  episode: number;
  /** Episode title after the SxxEyy marker ("" when absent). */
  title: string;
}

export interface Classification {
  kind: EntryKind;
  episode: EpisodeName | null;
}

const VOD_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv', 'mpg', 'mpeg', 'webm', 'divx']);
const MOVIE_TYPES = new Set(['movie', 'movies', 'vod', 'film']);
const SERIES_TYPES = new Set(['series', 'serie', 'episode', 'tvshow', 'show']);

export function classifyEntry(input: ClassifyInput): Classification {
  const declared = (input.attributes['tvg-type'] ?? input.attributes['type'] ?? '').trim().toLowerCase();
  const path = input.url?.pathname.toLowerCase() ?? '';

  const declaredSeries = SERIES_TYPES.has(declared);
  const xtreamSeries = /\/series\//.test(path);
  if (declaredSeries || xtreamSeries) {
    const episode = parseEpisodeName(input.name);
    if (episode) return { kind: 'episode', episode };
    // A series item without SxxEyy cannot be placed in a season: treat it as a movie.
    return { kind: 'movie', episode: null };
  }

  if (MOVIE_TYPES.has(declared) || /\/movies?\//.test(path)) return { kind: 'movie', episode: null };

  const extension = path.slice(path.lastIndexOf('.') + 1);
  if (path.includes('.') && VOD_EXTENSIONS.has(extension) && input.duration > 0) {
    const episode = parseEpisodeName(input.name);
    return episode ? { kind: 'episode', episode } : { kind: 'movie', episode: null };
  }

  return { kind: 'live', episode: null };
}

const EPISODE_PATTERNS = [
  // "Breaking Bad S01E02 - Cat's in the Bag", "Show.S1.E2", "Show - S01 E02"
  /^(.*?)[\s._\-:|]*\bS(\d{1,2})[\s._-]*E(\d{1,4})\b[\s._\-:|]*(.*)$/i,
  // "Show 1x02 Title"
  /^(.*?)[\s._\-:|]+(\d{1,2})x(\d{1,3})\b[\s._\-:|]*(.*)$/i,
  // "Сериал Сезон 1 Серия 2", "Show Season 1 Episode 2"
  /^(.*?)[\s._\-:|]*(?:season|сезон|სეზონი)\s*(\d{1,2})[\s._\-:|,]*(?:episode|серия|ეპიზოდი|სერია)\s*(\d{1,4})\b[\s._\-:|]*(.*)$/i,
];

export function parseEpisodeName(name: string): EpisodeName | null {
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(name.trim());
    if (!match) continue;
    const seriesName = cleanTitle(match[1] ?? '');
    const season = Number(match[2]);
    const episode = Number(match[3]);
    if (!seriesName || !Number.isFinite(season) || !Number.isFinite(episode)) continue;
    return { seriesName, season, episode, title: cleanTitle(match[4] ?? '') };
  }
  return null;
}

/** "The Matrix (1999)", "The Matrix - 1999", "The Matrix 1999" → { title, year }. */
export function extractYear(name: string): { title: string; year: number | null } {
  const match = /^(.*?)[\s._-]*[([]?((?:19|20)\d{2})[)\]]?\s*$/.exec(name.trim());
  if (match && match[1] && match[1].trim().length > 0) {
    const year = Number(match[2]);
    if (year >= 1900 && year <= new Date().getUTCFullYear() + 2) return { title: cleanTitle(match[1]), year };
  }
  return { title: name.trim(), year: null };
}

function cleanTitle(value: string): string {
  return value
    .replace(/[\s._\-:|]+$/g, '')
    .replace(/^[\s._\-:|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
