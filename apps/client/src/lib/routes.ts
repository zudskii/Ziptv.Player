/** In-app paths of catalog items (one place, so links stay consistent). */
export const paths = {
  channel: (sourceId: string, key: string) => `/live/${sourceId}/${key}`,
  movie: (sourceId: string, key: string) => `/movies/${sourceId}/${key}`,
  series: (sourceId: string, key: string) => `/series/${sourceId}/${key}`,
  playMovie: (sourceId: string, key: string) => `/play/movie/${sourceId}/${key}`,
  playEpisode: (sourceId: string, seriesKey: string, key: string) => `/play/episode/${sourceId}/${seriesKey}/${key}`,
  movies: (sourceId?: string, category?: string | null) => `/movies${sourceId ? `/${sourceId}` : ''}${category ? `?category=${encodeURIComponent(category)}` : ''}`,
  seriesList: (sourceId?: string, category?: string | null) => `/series${sourceId ? `/${sourceId}` : ''}${category ? `?category=${encodeURIComponent(category)}` : ''}`,
  search: (q: string) => `/search?q=${encodeURIComponent(q)}`,
};

export function itemPath(item: { type: 'channel' | 'movie' | 'series'; sourceId: string; key: string }): string {
  switch (item.type) {
    case 'channel':
      return paths.channel(item.sourceId, item.key);
    case 'movie':
      return paths.movie(item.sourceId, item.key);
    case 'series':
      return paths.series(item.sourceId, item.key);
  }
}
