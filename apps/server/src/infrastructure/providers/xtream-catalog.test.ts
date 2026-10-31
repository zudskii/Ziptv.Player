import { describe, expect, it } from 'vitest';

import { parsePlaylistText } from '../parsers/m3u/index.js';
import { buildCatalogFromPlaylist } from './m3u-catalog.js';
import { buildXtreamCatalog, readSeriesDetails, readUserInfo, type XtreamUserInfo } from './xtream-catalog.js';

const user: XtreamUserInfo = { account: { status: 'Active', expiresAt: null, maxConnections: 1, activeConnections: 0, trial: false }, allowedFormats: ['ts'] };
const options = { maxEntries: 1000, epgUrl: 'http://panel/xmltv.php?username=u&password=p' };
const empty = { liveCategories: [], liveStreams: [], vodCategories: [], vodStreams: [], seriesCategories: [], series: [] };

describe('readUserInfo', () => {
  it('reads the account with string-typed numbers', () => {
    expect(readUserInfo({ user_info: { auth: '1', status: 'Active', exp_date: '1900000000', is_trial: '1', active_cons: '2', max_connections: '3', allowed_output_formats: ['m3u8', 5, null] } })).toEqual({
      account: { status: 'Active', expiresAt: new Date(1_900_000_000_000), maxConnections: 3, activeConnections: 2, trial: true },
      allowedFormats: ['m3u8', '5'],
    });
    expect(readUserInfo({ user_info: { auth: 1, exp_date: null } })?.account).toMatchObject({ status: 'Active', expiresAt: null, maxConnections: null });
  });

  it('treats auth 0, empty or foreign payloads as rejected credentials', () => {
    for (const payload of [{ user_info: { auth: 0 } }, null, [], 'x', { user_info: [] }, {}]) expect(readUserInfo(payload)).toBeNull();
  });
});

describe('buildXtreamCatalog', () => {
  it('maps live channels (MPEG-TS when HLS is not allowed, archive, adult flag, multiple categories)', () => {
    const build = buildXtreamCatalog(
      {
        ...empty,
        liveCategories: [{ category_id: '1', category_name: ' News ' }, { category_id: 2, category_name: 'XXX Adults' }],
        liveStreams: {
          a: { name: 'One', stream_id: '7', category_id: 1, category_ids: [1, 2], tv_archive: '1', tv_archive_duration: '99', epg_channel_id: 'one.tv', stream_icon: 'http://img/1.png', added: '1700000000' },
          b: { name: 'Two', stream_id: 8, category_id: '9', is_adult: '1', stream_icon: 'javascript:alert(1)', added: '0' },
          c: { name: 'No id' },
        },
      },
      user,
      options,
    );
    expect(build.live.map((c) => [c.name, c.groups, c.kind, c.catchup, c.adult, c.xtream, c.logo, c.addedAt?.getTime() ?? null])).toEqual([
      ['One', ['News', 'XXX Adults'], 'mpegts', { mode: 'xtream', days: 30, template: null }, true, { id: 7, epgChannelId: 'one.tv' }, 'http://img/1.png', 1_700_000_000_000],
      ['Two', [], 'mpegts', null, true, { id: 8, epgChannelId: null }, null, null],
    ]);
    expect(build.live.every((c) => c.locator === null)).toBe(true);
    expect(build).toMatchObject({ format: 'xtream', epgUrls: [options.epgUrl], account: user.account, warningCount: 1, truncated: false });
  });

  it('maps movies and series with ratings, years and extensions', () => {
    const build = buildXtreamCatalog(
      {
        ...empty,
        vodCategories: [{ category_id: '5', category_name: 'Films' }],
        vodStreams: [
          { name: 'Heat (1995)', stream_id: 1, category_id: '5', container_extension: 'MKV', rating: '', rating_5based: '4.1' },
          { name: 'Odd', stream_id: 2, container_extension: '../x', rating: 'N/A', year: '2031' },
        ],
        seriesCategories: [{ category_id: '6', category_name: 'Shows' }],
        series: [{ name: 'Lost', series_id: '4', category_id: '6', releaseDate: '2004-09-22', rating: '8', genre: 'Drama / Mystery', cover: 'http://img/lost.jpg' }],
      },
      user,
      options,
    );
    expect(build.movies.map((m) => [m.name, m.year, m.rating, m.kind, m.xtream])).toEqual([
      ['Heat', 1995, 8.2, 'progressive', { id: 1, ext: 'mkv' }],
      ['Odd', 2031, null, 'progressive', { id: 2, ext: 'mp4' }],
    ]);
    expect(build.series.map((s) => [s.name, s.year, s.rating, s.genres, s.groups, s.cover, s.xtream])).toEqual([['Lost', 2004, 8, ['Drama', 'Mystery'], ['Shows'], 'http://img/lost.jpg', { id: 4 }]]);
  });

  it('caps the total number of entries and marks the build truncated', () => {
    const streams = Array.from({ length: 5 }, (_, i) => ({ name: `C${i}`, stream_id: i + 1 }));
    const build = buildXtreamCatalog({ ...empty, liveStreams: streams, vodStreams: [{ name: 'M', stream_id: 9 }] }, user, { ...options, maxEntries: 3 });
    expect(build.live).toHaveLength(3);
    expect(build.movies).toHaveLength(0);
    expect(build.truncated).toBe(true);
    expect(build.warnings.map((w) => w.code)).toEqual(['truncated']);
  });

  it('produces the same live and movie keys as the M3U export of the same panel', () => {
    const m3u = buildCatalogFromPlaylist(
      parsePlaylistText(
        [
          '#EXTM3U',
          '#EXTINF:-1 group-title="News",BBC One',
          'http://panel/live/u/p/1.ts',
          '#EXTINF:-1 group-title="News",BBC One',
          'http://panel/live/u/p/2.ts',
          '#EXTINF:-1 group-title="Films",Heat (1995)',
          'http://panel/movie/u/p/3.mkv',
        ].join('\n'),
      ),
    );
    const xtream = buildXtreamCatalog(
      {
        ...empty,
        liveCategories: [
          { category_id: '1', category_name: 'News' },
          { category_id: '7', category_name: 'UK' },
        ],
        liveStreams: [
          // Extra categories are displayed but must not change the key (get.php carries one group).
          { name: 'BBC One', stream_id: 1, category_id: '1', category_ids: [1, 7] },
          { name: 'BBC One', stream_id: 2, category_id: '1' },
        ],
        vodCategories: [{ category_id: '2', category_name: 'Films' }],
        vodStreams: [{ name: 'Heat (1995)', stream_id: 3, category_id: '2', container_extension: 'mkv' }],
      },
      user,
      options,
    );
    expect(xtream.live.map((c) => c.key)).toEqual(m3u.live.map((c) => c.key));
    expect(xtream.live[0]!.groups).toEqual(['News', 'UK']);
    expect(xtream.movies.map((m) => m.key)).toEqual(m3u.movies.map((m) => m.key));
  });
});

describe('readSeriesDetails', () => {
  it('reads episodes from object or array-of-arrays forms, sorted, with unique keys', () => {
    const asObject = readSeriesDetails(
      {
        info: { plot: 'Plot.' },
        episodes: {
          '2': [{ id: '21', episode_num: '1', season: '2', title: 'Two-One', container_extension: 'mkv', info: { duration_secs: '60', movie_image: 'http://img/s.jpg', releasedate: '2020-01-01' } }],
          '1': [
            { id: 12, episode_num: 2, season: 1 },
            { id: 11, episode_num: 1, season: 1, title: 'One-One' },
            { id: 13, episode_num: 1, season: 1, title: 'Duplicate number' },
            { title: 'no id' },
          ],
        },
      },
      'abcdefabcdef',
      100,
    );
    expect(asObject.plot).toBe('Plot.');
    expect(asObject.episodes.map((e) => [e.season, e.episode, e.title, e.xtream, e.kind])).toEqual([
      [1, 1, 'One-One', { id: 11, ext: 'mp4' }, 'progressive'],
      [1, 1, 'Duplicate number', { id: 13, ext: 'mp4' }, 'progressive'],
      [1, 2, 'Episode 2', { id: 12, ext: 'mp4' }, 'progressive'],
      [2, 1, 'Two-One', { id: 21, ext: 'mkv' }, 'progressive'],
    ]);
    expect(new Set(asObject.episodes.map((e) => e.key)).size).toBe(4);
    expect(asObject.episodes[3]).toMatchObject({ durationSecs: 60, still: 'http://img/s.jpg', airDate: '2020-01-01', seriesKey: 'abcdefabcdef', locator: null });

    const asArray = readSeriesDetails({ episodes: [[{ id: 1, episode_num: 1, season: 1 }]] }, 'abcdefabcdef', 100);
    expect(asArray.episodes).toHaveLength(1);
    expect(readSeriesDetails({ episodes: [] }, 'abcdefabcdef', 100)).toEqual({ episodes: [], plot: null });
    expect(readSeriesDetails(null, 'abcdefabcdef', 100).episodes).toEqual([]);
  });

  it('skips out-of-range numbers and numbers missing episodes deterministically, whatever the panel order', () => {
    const items = [
      { id: 30, season: 1 },
      { id: 10, season: 1, episode_num: 1 },
      { id: 20, season: 1 },
      { id: 40, season: '9999999999', episode_num: 1 },
      { id: '1e21', season: 1, episode_num: 3 },
    ];
    const forward = readSeriesDetails({ episodes: { 1: items } }, 'abcdefabcdef', 100).episodes;
    const backward = readSeriesDetails({ episodes: { 1: [...items].reverse() } }, 'abcdefabcdef', 100).episodes;
    expect(forward.map((e) => [e.xtream?.id, e.episode])).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(backward.map((e) => e.key)).toEqual(forward.map((e) => e.key));
  });

  it('caps the episode count', () => {
    const episodes = { '1': Array.from({ length: 10 }, (_, i) => ({ id: i + 1, episode_num: i + 1, season: 1 })) };
    expect(readSeriesDetails({ episodes }, 'abcdefabcdef', 4).episodes).toHaveLength(4);
  });
});
