import type { SeriesDetails } from '../../application/ports/series-details-source.js';
import { isAdultEntry } from '../../domain/catalog/adult.js';
import { extractYear } from '../../domain/catalog/classify.js';
import { createContentKeyFactory, episodeKey, type ContentKeyFactory } from '../../domain/catalog/content-key.js';
import type {
  CatalogBuild,
  CatalogWarning,
  EpisodeEntry,
  LiveChannelEntry,
  MovieEntry,
  ProviderAccount,
  SeriesEntry,
  StreamKind,
} from '../../domain/catalog/model.js';
import { kindFromExtension } from '../../domain/playback/plan.js';
import { preferredLiveExtension } from '../../domain/sources/xtream.js';
import { parseImageUrl } from '../parsers/m3u/stream-location.js';
import { normalizeLabel } from '../parsers/m3u/text.js';

/**
 * Xtream Codes `player_api.php` JSON → catalog model (pure, no I/O).
 *
 * Panels differ wildly in how they serialise the same fields (numbers as strings, `{}` or
 * `null` instead of an empty array, `episodes` as an object or as an array of arrays), so
 * every field is read defensively and anything unusable is skipped with a warning.
 *
 * Keys use the same factory, inputs and order as an M3U `get.php?type=m3u_plus` export of the
 * same panel (live, then movies; name + the primary category, which is what `group-title`
 * carries), so converting an M3U source to Xtream keeps favourites, history and progress
 * pointing at the same items. Extra categories (`category_ids`) are shown but never keyed.
 *
 * The builder consumes one list at a time, so the provider can drop each raw JSON list as
 * soon as it is converted instead of holding all three in memory.
 */

export interface XtreamUserInfo {
  account: ProviderAccount;
  allowedFormats: string[];
}

const MAX_WARNINGS = 50;
const MAX_ARCHIVE_DAYS = 30;
const MAX_SEASON_OR_EPISODE = 9_999;

type Json = Record<string, unknown>;

/** `user_info` of the authentication call; null = the panel rejected the credentials. */
export function readUserInfo(payload: unknown): XtreamUserInfo | null {
  const info = asObject(asObject(payload)?.['user_info']);
  if (!info || toInt(info['auth']) !== 1) return null;
  const expires = toInt(info['exp_date']);
  return {
    account: {
      status: toText(info['status'])?.slice(0, 40) ?? 'Active',
      expiresAt: expires && expires > 0 && expires < 32_503_680_000 ? new Date(expires * 1000) : null,
      maxConnections: smallCount(info['max_connections']),
      activeConnections: smallCount(info['active_cons']),
      trial: toInt(info['is_trial']) === 1,
    },
    allowedFormats: toArray(info['allowed_output_formats'])
      .map((format) => toText(format))
      .filter((format): format is string => !!format),
  };
}

export class XtreamCatalogBuilder {
  private readonly live: LiveChannelEntry[] = [];
  private readonly movies: MovieEntry[] = [];
  private readonly series: SeriesEntry[] = [];
  private readonly warnings = new WarningList();
  /** One factory for live + movies, in that order — exactly like the M3U parser over get.php. */
  private readonly keys: ContentKeyFactory = createContentKeyFactory();
  private readonly seriesKeys: ContentKeyFactory = createContentKeyFactory();
  private readonly liveKind: StreamKind;
  private budget: number;
  private truncated = false;

  constructor(
    private readonly user: XtreamUserInfo,
    private readonly options: { maxEntries: number; epgUrl: string },
  ) {
    this.liveKind = preferredLiveExtension(user.allowedFormats) === 'm3u8' ? 'hls' : 'mpegts';
    this.budget = options.maxEntries;
  }

  addLive(categories: unknown, streams: unknown): void {
    const names = categoryNames(categories);
    for (const raw of toArray(streams)) {
      if (this.truncated) return;
      const item = asObject(raw);
      const id = toId(item?.['stream_id']);
      const name = normalizeLabel(toText(item?.['name']));
      if (!item || !id || !name) {
        this.warnings.add('invalid_entry', 'Skipped a live channel without an id or a name.');
        continue;
      }
      if (!this.take()) return;
      const { primary, groups } = groupsOf(item, names);
      const archive = toInt(item['tv_archive']) === 1 ? clamp(toInt(item['tv_archive_duration']) ?? 1, 1, MAX_ARCHIVE_DAYS) : null;
      const epgChannelId = normalizeLabel(toText(item['epg_channel_id'])) || null;
      this.live.push({
        key: this.keys({ name, groups: primary }),
        position: this.live.length,
        name,
        groups,
        logo: parseImageUrl(toText(item['stream_icon'])),
        tvgId: epgChannelId,
        tvgName: null,
        kind: this.liveKind,
        unplayableReason: null,
        locator: null,
        catchup: archive ? { mode: 'xtream', days: archive, template: null } : null,
        adult: isAdultEntry({ name, groups }, toInt(item['is_adult']) === 1),
        xtream: { id, epgChannelId },
        addedAt: toDate(item['added']),
        epg: null,
      });
    }
  }

  addMovies(categories: unknown, streams: unknown): void {
    const names = categoryNames(categories);
    for (const raw of toArray(streams)) {
      if (this.truncated) return;
      const item = asObject(raw);
      const id = toId(item?.['stream_id']);
      const rawName = normalizeLabel(toText(item?.['name']));
      if (!item || !id || !rawName) {
        this.warnings.add('invalid_entry', 'Skipped a movie without an id or a name.');
        continue;
      }
      if (!this.take()) return;
      const { primary, groups } = groupsOf(item, names);
      const ext = containerExtension(item['container_extension'], 'mp4');
      const { title, year } = extractYear(rawName);
      this.movies.push({
        key: this.keys({ name: rawName, groups: primary }),
        position: this.movies.length,
        name: title || rawName,
        year: validYear(toInt(item['year'])) ?? year,
        groups,
        poster: parseImageUrl(toText(item['stream_icon']) ?? toText(item['cover'])),
        rating: readRating(item),
        genres: splitList(toText(item['genre'])),
        durationSecs: duration(item['duration_secs']),
        plot: text(item['plot']) ?? text(item['description']),
        kind: kindFromExtension(ext),
        locator: null,
        adult: isAdultEntry({ name: rawName, groups }, toInt(item['is_adult']) === 1),
        xtream: { id, ext },
        addedAt: toDate(item['added']),
      });
    }
  }

  addSeries(categories: unknown, list: unknown): void {
    const names = categoryNames(categories);
    for (const raw of toArray(list)) {
      if (this.truncated) return;
      const item = asObject(raw);
      const id = toId(item?.['series_id']);
      const rawName = normalizeLabel(toText(item?.['name']));
      if (!item || !id || !rawName) {
        this.warnings.add('invalid_entry', 'Skipped a series without an id or a name.');
        continue;
      }
      if (!this.take()) return;
      const { primary, groups } = groupsOf(item, names);
      const { title, year } = extractYear(rawName);
      this.series.push({
        key: this.seriesKeys({ name: rawName, groups: primary }),
        position: this.series.length,
        name: title || rawName,
        year: year ?? validYear(yearOf(toText(item['releaseDate']) ?? toText(item['release_date']))),
        groups,
        cover: parseImageUrl(toText(item['cover'])),
        rating: readRating(item),
        genres: splitList(toText(item['genre'])),
        plot: text(item['plot']),
        adult: isAdultEntry({ name: rawName, groups }),
        xtream: { id },
        addedAt: toDate(item['last_modified']),
      });
    }
  }

  warn(code: string, message: string): void {
    this.warnings.add(code, message);
  }

  build(): CatalogBuild {
    return {
      live: this.live,
      movies: this.movies,
      series: this.series,
      episodes: [],
      epgUrls: [this.options.epgUrl],
      format: 'xtream',
      encoding: 'utf-8',
      warnings: this.warnings.items,
      warningCount: this.warnings.count,
      truncated: this.truncated,
      account: this.user.account,
      xtreamCandidate: false,
    };
  }

  private take(): boolean {
    if (this.budget > 0) {
      this.budget--;
      return true;
    }
    if (!this.truncated) this.warnings.add('truncated', `The account has more than ${this.options.maxEntries} entries; the rest was not imported.`);
    this.truncated = true;
    return false;
  }
}

/** All lists at once (tests, small panels). */
export function buildXtreamCatalog(
  listings: { liveCategories: unknown; liveStreams: unknown; vodCategories: unknown; vodStreams: unknown; seriesCategories: unknown; series: unknown },
  user: XtreamUserInfo,
  options: { maxEntries: number; epgUrl: string },
): CatalogBuild {
  const builder = new XtreamCatalogBuilder(user, options);
  builder.addLive(listings.liveCategories, listings.liveStreams);
  builder.addMovies(listings.vodCategories, listings.vodStreams);
  builder.addSeries(listings.seriesCategories, listings.series);
  return builder.build();
}

interface RawEpisode {
  id: number;
  season: number;
  number: number | null;
  item: Json;
}

/**
 * `get_series_info` → episodes of one series. Keys match the M3U import (series + S + E);
 * episodes are ordered by season, number and id before keys are assigned, so duplicate numbers
 * and missing numbers get the same keys on every sync regardless of the panel's ordering.
 */
export function readSeriesDetails(payload: unknown, seriesKey: string, maxEpisodes: number): SeriesDetails {
  const root = asObject(payload);
  const info = asObject(root?.['info']);
  const groups = root?.['episodes'];
  const lists: unknown[] = Array.isArray(groups) ? groups : Object.values(asObject(groups) ?? {});

  const raws: RawEpisode[] = [];
  outer: for (const list of lists) {
    for (const raw of toArray(list)) {
      if (raws.length >= maxEpisodes) break outer;
      const item = asObject(raw);
      const id = toId(item?.['id']);
      if (!item || !id) continue;
      const season = toInt(item['season']) ?? 1;
      const number = toInt(item['episode_num']);
      if (season < 0 || season > MAX_SEASON_OR_EPISODE || (number !== null && (number < 0 || number > MAX_SEASON_OR_EPISODE))) continue;
      raws.push({ id, season, number, item });
    }
  }
  raws.sort((a, b) => a.season - b.season || (a.number ?? Infinity) - (b.number ?? Infinity) || a.id - b.id);

  const episodes: EpisodeEntry[] = [];
  const used = new Set<string>();
  const lastNumber = new Map<number, number>();
  for (const { id, season, number: given, item } of raws) {
    const number = given ?? Math.min(MAX_SEASON_OR_EPISODE, (lastNumber.get(season) ?? 0) + 1);
    lastNumber.set(season, number);
    const details = asObject(item['info']);
    const ext = containerExtension(item['container_extension'], 'mp4');
    const base = episodeKey(seriesKey, season, number);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    episodes.push({
      key,
      seriesKey,
      season,
      episode: number,
      title: normalizeLabel(toText(item['title'])).slice(0, 300) || `Episode ${number}`,
      plot: text(details?.['plot']),
      durationSecs: duration(details?.['duration_secs']),
      still: parseImageUrl(toText(details?.['movie_image'])),
      airDate: toText(details?.['releasedate'])?.slice(0, 32) ?? toText(details?.['air_date'])?.slice(0, 32) ?? null,
      kind: kindFromExtension(ext),
      locator: null,
      xtream: { id, ext },
    });
  }
  return { episodes, plot: text(info?.['plot']) };
}

// --- field readers ---------------------------------------------------------------------------

function categoryNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of toArray(payload)) {
    const item = asObject(raw);
    const id = toText(item?.['category_id']);
    const name = normalizeLabel(toText(item?.['category_name']));
    if (id && name) names.set(id, name);
  }
  return names;
}

/** `primary` (keys) = the main category only; `groups` (display) = main + extra categories. */
function groupsOf(item: Json, names: Map<string, string>): { primary: string[]; groups: string[] } {
  const main = toText(item['category_id']);
  const mainName = main ? names.get(main) : undefined;
  const groups: string[] = mainName ? [mainName] : [];
  for (const id of toArray(item['category_ids']).slice(0, 20)) {
    const name = names.get(toText(id) ?? '');
    if (name && !groups.includes(name)) groups.push(name);
  }
  return { primary: mainName ? [mainName] : [], groups };
}

function readRating(item: Json): number | null {
  const rating = toNumber(item['rating']);
  if (rating && rating > 0) return Math.min(10, rating);
  const five = toNumber(item['rating_5based']);
  return five && five > 0 ? Math.min(10, five * 2) : null;
}

function containerExtension(value: unknown, fallback: string): string {
  const ext = toText(value)?.replace(/^\./, '').toLowerCase();
  return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,/|;]/)
    .map((item) => item.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 6);
}

/** Free text (plots): bounded, so one hostile row cannot bloat the catalog. */
function text(value: unknown): string | null {
  return toText(value)?.slice(0, 4000) ?? null;
}

function yearOf(value: string | null): number | null {
  const match = value ? /\b(\d{4})\b/.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function validYear(year: number | null): number | null {
  return year && year >= 1900 && year <= 2100 ? year : null;
}

function duration(value: unknown): number | null {
  const seconds = toInt(value);
  return seconds && seconds > 0 && seconds < 7 * 86_400 ? seconds : null;
}

function smallCount(value: unknown): number | null {
  const count = toInt(value);
  return count !== null && count >= 0 && count <= 100_000 ? count : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Positive safe integer id (`1e21` would print as `1e+21` in a stream URL). */
function toId(value: unknown): number | null {
  const id = toInt(value);
  return id !== null && id > 0 && Number.isSafeInteger(id) ? id : null;
}

function toDate(value: unknown): Date | null {
  const seconds = toInt(value);
  // Plausible unix seconds only (2000-01-01 … 2100-01-01); panels send 0, "", or garbage.
  return seconds && seconds > 946_684_800 && seconds < 4_102_444_800 ? new Date(seconds * 1000) : null;
}

export function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** Arrays as they are; `{ "0": …, "1": … }` objects as their values; anything else empty. */
export function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = asObject(value);
  return object ? Object.values(object) : [];
}

export function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function toNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

export function toInt(value: unknown): number | null {
  const number = toNumber(value);
  return number === null ? null : Math.trunc(number);
}

class WarningList {
  readonly items: CatalogWarning[] = [];
  count = 0;
  private readonly seen = new Set<string>();

  add(code: string, message: string): void {
    this.count++;
    // Repeated identical warnings (thousands of broken rows) are listed once.
    if (this.seen.has(code)) return;
    this.seen.add(code);
    if (this.items.length < MAX_WARNINGS) this.items.push({ line: 0, code, message });
  }
}
