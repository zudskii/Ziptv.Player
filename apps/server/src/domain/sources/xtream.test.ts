import { describe, expect, it } from 'vitest';

import { parseXtreamPlaylistUrl, preferredLiveExtension, xtreamApiUrl, xtreamStreamUrl, xtreamTimeshiftUrl, xtreamXmltvUrl } from './xtream.js';

const account = { server: 'http://panel.example:8080/sub', username: 'u ser', password: 'p/ss#1' };

describe('Xtream URL builders', () => {
  it('builds API and guide URLs relative to a server path, with encoded credentials', () => {
    expect(xtreamApiUrl(account, { action: 'get_series_info', series_id: '9' })).toBe(
      'http://panel.example:8080/sub/player_api.php?username=u+ser&password=p%2Fss%231&action=get_series_info&series_id=9',
    );
    expect(xtreamXmltvUrl({ ...account, server: 'http://panel.example/' })).toBe('http://panel.example/xmltv.php?username=u+ser&password=p%2Fss%231');
  });

  it('builds stream URLs with path-safe segments and a sane default extension', () => {
    expect(xtreamStreamUrl(account, 'live', 101, 'm3u8')).toBe('http://panel.example:8080/sub/live/u%20ser/p%2Fss%231/101.m3u8');
    expect(xtreamStreamUrl(account, 'movie', 77, '.MKV')).toBe('http://panel.example:8080/sub/movie/u%20ser/p%2Fss%231/77.mkv');
    expect(xtreamStreamUrl(account, 'series', 5, '')).toBe('http://panel.example:8080/sub/series/u%20ser/p%2Fss%231/5.mp4');
    expect(xtreamStreamUrl(account, 'live', 5, '')).toMatch(/\/5\.ts$/);
  });

  it('builds timeshift URLs in the panel timezone with whole minutes', () => {
    const start = new Date('2026-03-29T00:30:00Z');
    expect(xtreamTimeshiftUrl(account, 101, start, 44.2)).toBe('http://panel.example:8080/sub/timeshift/u%20ser/p%2Fss%231/45/2026-03-29:00-30/101.ts');
    expect(xtreamTimeshiftUrl(account, 101, start, 0, 120)).toContain('/1/2026-03-29:02-30/101.ts');
  });

  it('prefers HLS unless the account excludes it', () => {
    expect(preferredLiveExtension([])).toBe('m3u8');
    expect(preferredLiveExtension(['TS', 'M3U8'])).toBe('m3u8');
    expect(preferredLiveExtension(['ts', 'rtmp'])).toBe('ts');
  });

  it('recognises get.php M3U links and recovers the account', () => {
    expect(parseXtreamPlaylistUrl('http://user:x@panel.example:8080/get.php?username=a&password=b&type=m3u_plus#x')).toEqual({
      server: 'http://panel.example:8080/',
      username: 'a',
      password: 'b',
    });
    expect(parseXtreamPlaylistUrl('http://panel.example/list.m3u?username=a&password=b')).toBeNull();
    expect(parseXtreamPlaylistUrl('http://panel.example/get.php?username=a')).toBeNull();
    expect(parseXtreamPlaylistUrl('not a url')).toBeNull();
  });
});
