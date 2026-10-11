import { describe, expect, it } from 'vitest';

import { parsePlaylistText } from '../parsers/m3u/index.js';
import { buildCatalogFromPlaylist, isXtreamPlaylistUrl } from './m3u-catalog.js';

describe('M3U → catalog', () => {
  const playlist = [
    '#EXTM3U url-tvg="http://epg.example/guide.xml" catchup="shift" catchup-days="2"',
    '#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://l/bbc.png" group-title="UK",BBC One HD',
    'http://p.example:8080/live/u/p/1.ts',
    '#EXTINF:-1 group-title="XXX Adults",Late Night',
    'http://p.example:8080/live/u/p/2.ts',
    '#EXTINF:-1 tvg-logo="http://l/matrix.jpg" group-title="VOD | Action",The Matrix (1999)',
    'http://p.example:8080/movie/u/p/77.mp4',
    '#EXTINF:-1 tvg-logo="http://l/bb.jpg" group-title="Series | Drama",Breaking Bad S01E01 Pilot',
    'http://p.example:8080/series/u/p/501.mkv',
    '#EXTINF:-1 group-title="Series | Drama",Breaking Bad S01E02',
    'http://p.example:8080/series/u/p/502.mkv',
    '#EXTINF:-1 group-title="Series | Drama",Breaking Bad S02E01 Seven Thirty-Seven',
    'http://p.example:8080/series/u/p/601.mkv',
  ].join('\n');

  const build = buildCatalogFromPlaylist(parsePlaylistText(playlist, { baseUrl: new URL('http://p.example:8080/get.php?username=u&password=p') }));

  it('splits Live TV, Movies and Series → episodes', () => {
    expect(build.live.map((c) => c.name)).toEqual(['BBC One HD', 'Late Night']);
    expect(build.movies).toEqual([expect.objectContaining({ name: 'The Matrix', year: 1999, groups: ['VOD | Action'], poster: 'http://l/matrix.jpg', kind: 'progressive' })]);
    expect(build.series).toEqual([expect.objectContaining({ name: 'Breaking Bad', groups: ['Series | Drama'], cover: 'http://l/bb.jpg' })]);
    const seriesKey = build.series[0]!.key;
    expect(build.episodes.map((e) => [e.seriesKey === seriesKey, e.season, e.episode, e.title])).toEqual([
      [true, 1, 1, 'Pilot'],
      [true, 1, 2, 'Episode 2'],
      [true, 2, 1, 'Seven Thirty-Seven'],
    ]);
    expect(new Set(build.episodes.map((e) => e.key)).size).toBe(3);
  });

  it('applies header catch-up defaults, adult detection and keeps locators server-side', () => {
    expect(build.live[0]).toMatchObject({ tvgId: 'bbc1.uk', catchup: { mode: 'shift', days: 2 }, adult: false, locator: { url: 'http://p.example:8080/live/u/p/1.ts' } });
    expect(build.live[1]!.adult).toBe(true);
    expect(build.epgUrls).toEqual(['http://epg.example/guide.xml']);
  });

  it('keeps 2.x channel keys (computed over the whole list)', () => {
    const parsed = parsePlaylistText(playlist);
    expect(build.live[0]!.key).toBe(parsed.channels[0]!.key);
    expect(build.movies[0]!.key).toBe(parsed.channels[2]!.key);
  });

  it('recognises Xtream playlist URLs', () => {
    expect(isXtreamPlaylistUrl(new URL('http://h:8080/get.php?username=a&password=b&type=m3u_plus'))).toBe(true);
    expect(isXtreamPlaylistUrl(new URL('http://h/list.m3u'))).toBe(false);
  });
});
