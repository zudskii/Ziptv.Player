import type { MovieDto, SeriesDto, VodBrowsePageDto, VodLength, VodSort, VodWatchFilter } from '@ziptv/contracts';

import { isGenreId, type GenreId } from '../../domain/catalog/genres.js';
import { queryTerms } from '../../domain/shared/text.js';
import { AppError } from '../errors.js';
import { inLibrary, type Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { HiddenContent } from '../ports/catalog-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { ADDED_WINDOWS_DAYS, type VodBrowseFilters, type VodBrowseRepository, type VodBrowseScope, type VodCursor } from '../ports/vod-browse-repository.js';
import { directArtwork, type ArtworkUrls } from './artwork.js';
import { toMovieDto, toSeriesDto } from './catalog-mapper.js';
import type { LiveCatalogService } from './live.service.js';

const MAX_PAGE = 100;

export interface VodBrowseInput {
  sources?: string[] | undefined;
  genres?: string[] | undefined;
  category?: string | undefined;
  yearMin?: number | undefined;
  yearMax?: number | undefined;
  ratingMin?: number | undefined;
  length?: VodLength | undefined;
  added?: number | undefined;
  watch?: VodWatchFilter | undefined;
  q?: string | undefined;
  sort: VodSort;
  cursor?: string | undefined;
  limit: number;
  facets: boolean;
}

/**
 * Movies & Series filters (Phase 15): one filtered, sorted list across every source of the
 * profile's library — genre, year, rating, length, date added, source, watched — with facet counts
 * and keyset pagination. Parental rules apply exactly as in the per-source lists: adult content is
 * left out for kids / "hide adult", a kids profile's locked groups and items are left out, and
 * locked items show as locked for everyone else.
 */
export class VodBrowseService {
  constructor(
    private readonly deps: {
      sources: Pick<SourceRepository, 'listByOwner'>;
      browse: VodBrowseRepository;
      live: Pick<LiveCatalogService, 'isLocked'>;
      clock: Clock;
      artwork?: ArtworkUrls;
    },
  ) {}

  async movies(viewer: Viewer, input: VodBrowseInput): Promise<VodBrowsePageDto<MovieDto>> {
    const query = await this.query(viewer, 'movies', input);
    const page = await this.deps.browse.browseMovies(query);
    const artwork = this.deps.artwork ?? directArtwork;
    return {
      items: page.items.map((movie) => toMovieDto(movie.sourceId, movie, this.deps.live.isLocked(viewer, movie.sourceId, movie), artwork)),
      nextCursor: page.next ? encodeCursor(input.sort, page.next) : null,
      total: page.total,
      ...(page.facets ? { facets: page.facets } : {}),
    };
  }

  async series(viewer: Viewer, input: VodBrowseInput): Promise<VodBrowsePageDto<SeriesDto>> {
    if (input.watch === 'finished' || input.length) throw AppError.validation('"finished" and length filters apply to movies only.');
    const query = await this.query(viewer, 'series', input);
    const page = await this.deps.browse.browseSeries(query);
    const artwork = this.deps.artwork ?? directArtwork;
    return {
      items: page.items.map((series) => toSeriesDto(series.sourceId, series, this.deps.live.isLocked(viewer, series.sourceId, series), artwork)),
      nextCursor: page.next ? encodeCursor(input.sort, page.next) : null,
      total: page.total,
      ...(page.facets ? { facets: page.facets } : {}),
    };
  }

  private async query(viewer: Viewer, _kind: 'movies' | 'series', input: VodBrowseInput) {
    const library = inLibrary(viewer, await this.deps.sources.listByOwner(viewer.userId)).filter((source) => source.revision > 0);
    const scopes: VodBrowseScope[] = library.map((source) => ({ ref: { sourceId: source.id, revision: source.revision }, hidden: hiddenFor(viewer, source.id) }));
    // A source outside the library (or unknown) is simply not part of the result.
    const sourceIds = input.sources?.length ? input.sources.filter((id) => library.some((source) => source.id === id)) : undefined;
    const genres = input.genres?.filter(isGenreId) as GenreId[] | undefined;
    if (input.yearMin !== undefined && input.yearMax !== undefined && input.yearMin > input.yearMax) throw AppError.validation('yearMin is after yearMax.');
    if (input.added !== undefined && !(ADDED_WINDOWS_DAYS as readonly number[]).includes(input.added)) throw AppError.validation(`added must be one of ${ADDED_WINDOWS_DAYS.join(', ')}.`);
    const now = this.deps.clock.now();
    const terms = input.q ? queryTerms(input.q) : [];
    const filters: VodBrowseFilters = {
      ...(sourceIds ? { sourceIds } : {}),
      ...(genres?.length ? { genres } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.yearMin !== undefined ? { yearMin: input.yearMin } : {}),
      ...(input.yearMax !== undefined ? { yearMax: input.yearMax } : {}),
      ...(input.ratingMin !== undefined ? { ratingMin: input.ratingMin } : {}),
      ...(input.length ? { length: input.length } : {}),
      ...(input.added !== undefined ? { addedSince: new Date(now.getTime() - input.added * 86_400_000) } : {}),
      ...(input.watch ? { watch: input.watch } : {}),
      ...(terms.length ? { terms } : {}),
    };
    return {
      scopes,
      filters,
      hideAdult: viewer.kids || viewer.hideAdult,
      profileId: viewer.profileId,
      sort: input.sort,
      after: input.cursor ? decodeCursor(input.sort, input.cursor) : null,
      limit: Math.min(Math.max(input.limit, 1), MAX_PAGE),
      facets: input.facets,
      now,
    };
  }
}

/** Opaque to clients: the sort it belongs to plus the keyset position. */
function encodeCursor(sort: VodSort, cursor: VodCursor): string {
  return Buffer.from(JSON.stringify([sort, cursor.value, cursor.sourceId, cursor.position])).toString('base64url');
}

function decodeCursor(sort: VodSort, raw: string): VodCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 4) {
      const [cursorSort, value, sourceId, position] = parsed as unknown[];
      const valueOk = sort === 'name' ? typeof value === 'string' || typeof value === 'number' : typeof value === 'number' && Number.isFinite(value);
      if (cursorSort === sort && valueOk && typeof sourceId === 'string' && /^[0-9a-f-]{36}$/i.test(sourceId) && Number.isSafeInteger(position)) {
        return { value: value as string | number, sourceId, position: position as number };
      }
    }
  } catch {
    // fall through
  }
  throw AppError.validation('Invalid cursor.');
}

/** Kids profiles: the source's locked groups and items are left out (not shown as locked). */
function hiddenFor(viewer: Viewer, sourceId: string): HiddenContent | undefined {
  if (!viewer.kids) return undefined;
  const prefix = `${sourceId}|`;
  const pick = (keys: ReadonlySet<string>) => [...keys].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  const hidden = { groups: pick(viewer.lockedGroups), keys: pick(viewer.lockedChannels) };
  return hidden.groups.length || hidden.keys.length ? hidden : undefined;
}
