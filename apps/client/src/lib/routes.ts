import type { HistoryItemDto, ListItemType } from '@ziptv/contracts';

/** In-app paths of catalog items (one place, so links stay consistent). */
export const paths = {
  channel: (sourceId: string, key: string) => `/live/${sourceId}/${key}`,
  /** A past programme of a channel, replayed from its archive (catch-up). */
  archive: (sourceId: string, key: string, programme: { start: string; end: string }) => `/live/${sourceId}/${key}?${archiveQuery(programme)}`,
  /** A past programme of a licensed channel (catch-up rights). */
  operatorArchive: (channelId: string, programme: { start: string; end: string }) => `/channels/${channelId}?${archiveQuery(programme)}`,
  /** Operator (licensed) channel, by master channel id. */
  operatorChannel: (channelId: string) => `/channels/${channelId}`,
  movie: (sourceId: string, key: string) => `/movies/${sourceId}/${key}`,
  series: (sourceId: string, key: string) => `/series/${sourceId}/${key}`,
  playMovie: (sourceId: string, key: string) => `/play/movie/${sourceId}/${key}`,
  playEpisode: (sourceId: string, seriesKey: string, key: string) => `/play/episode/${sourceId}/${seriesKey}/${key}`,
  movies: (sourceId?: string, category?: string | null) => `/movies${sourceId ? `/${sourceId}` : ''}${category ? `?category=${encodeURIComponent(category)}` : ''}`,
  seriesList: (sourceId?: string, category?: string | null) => `/series${sourceId ? `/${sourceId}` : ''}${category ? `?category=${encodeURIComponent(category)}` : ''}`,
  search: (q: string) => `/search?q=${encodeURIComponent(q)}`,
  /** The operator's films and series (Phase 17). */
  films: '/films',
  film: (id: string) => `/films/${id}`,
  playFilm: (id: string, episodeId?: string) => `/films/${id}/play${episodeId ? `?episode=${encodeURIComponent(episodeId)}` : ''}`,
};

function archiveQuery(programme: { start: string; end: string }): string {
  return new URLSearchParams({ at: programme.start, until: programme.end }).toString();
}

/** `?at=&until=` of an archive link, when both are valid instants. */
export function archiveRange(params: URLSearchParams): { start: string; end: string } | null {
  const start = params.get('at');
  const end = params.get('until');
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return null;
  return { start, end };
}

export function itemPath(item: { type: ListItemType; sourceId: string; key: string }): string {
  switch (item.type) {
    case 'channel':
      return paths.channel(item.sourceId, item.key);
    case 'operator':
      return paths.operatorChannel(item.key);
    case 'movie':
      return paths.movie(item.sourceId, item.key);
    case 'series':
      return paths.series(item.sourceId, item.key);
  }
}

/** Where a history entry leads: the channel, or the details page of what was watched. */
export function historyPath(item: Pick<HistoryItemDto, 'contentType' | 'sourceId' | 'key' | 'seriesKey'>): string {
  switch (item.contentType) {
    case 'movie':
      return paths.movie(item.sourceId, item.key);
    case 'episode':
      return item.seriesKey ? paths.series(item.sourceId, item.seriesKey) : paths.channel(item.sourceId, item.key);
    case 'operator':
      return paths.operatorChannel(item.key);
    default:
      return paths.channel(item.sourceId, item.key);
  }
}
