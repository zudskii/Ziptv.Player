import { gzipSync } from 'node:zlib';

import type {
  ChannelEpgLinkDto,
  ChannelListDto,
  ChannelScheduleDto,
  EpgSearchResultDto,
  GuideChannelOptionDto,
  GuideDto,
  GuideSourceDto,
  NotificationListDto,
  NowNextListDto,
  SessionDto,
  SourceDto,
} from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

const HOUR = 3600_000;

function xmltvTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}00 +0000`;
}

/** Hourly programmes from 2 days ago to 2 days ahead for each guide channel. */
function buildGuide(): string {
  const channels = [
    { id: 'news.ge', names: ['News Channel'] },
    { id: 'Sport1.ge', names: [] },
    { id: 'extra.ge', names: ['Extra Channel'] },
    { id: 'unused.ge', names: ['Nobody Watches This'] },
  ];
  const base = new Date(Math.floor(Date.now() / HOUR) * HOUR - 48 * HOUR);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    parts.push(`<channel id="${channel.id}">${channel.names.map((name) => `<display-name>${name}</display-name>`).join('')}</channel>`);
  }
  for (const channel of channels) {
    for (let hour = 0; hour < 96; hour++) {
      const start = new Date(base.getTime() + hour * HOUR);
      const title = channel.id === 'Sport1.ge' && hour % 2 === 0 ? 'Champions League Live' : `${channel.id} show ${hour}`;
      parts.push(
        `<programme start="${xmltvTime(start)}" stop="${xmltvTime(new Date(start.getTime() + HOUR))}" channel="${channel.id}"><title>${title}</title><desc>About ${title}</desc><category>Sport</category></programme>`,
      );
    }
  }
  parts.push('</tv>');
  return parts.join('\n');
}

describe.skipIf(!TEST_DATABASE_URL)('EPG end-to-end', () => {
  let t: TestApp;
  let origin: FakeOrigin;
  let token = '';
  let source: SourceDto;
  let guideRequests = 0;
  let guideBroken = false;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/list.m3u') {
        res.writeHead(200).end(
          [
            `#EXTM3U x-tvg-url="${originUrl()}/guide.xml.gz"`,
            '#EXTINF:-1 tvg-id="NEWS.ge" group-title="News",News HD',
            'http://streams.example/news.m3u8',
            '#EXTINF:-1 group-title="Sports" catchup="default" catchup-days="3" catchup-source="?utc={utc}",UK: Sport 1 FHD',
            'http://streams.example/sport1.m3u8',
            '#EXTINF:-1 group-title="Other",Mystery Channel',
            'http://streams.example/mystery.m3u8',
          ].join('\n'),
        );
        return;
      }
      if (path === '/guide.xml.gz') {
        guideRequests++;
        if (guideBroken) return void res.writeHead(500).end();
        // Served as octet-stream without Content-Encoding, like many XMLTV hosts.
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(gzipSync(buildGuide()));
        return;
      }
      if (path === '/manual.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' }).end('<tv><channel id="m1"><display-name>Manual One</display-name></channel></tv>');
        return;
      }
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true' });
    t.container.jobs.start();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
  });

  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  const originUrl = () => origin.url;

  it('attaches the guide the playlist announces, syncs it and links channels (tvg-id, then name)', async () => {
    source = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/list.m3u` }).expect(202)).body as SourceDto;
    const guide = await waitFor(async () => {
      const guides = (await request(t.app).get('/api/v1/epg/guides').set(auth())).body as GuideSourceDto[];
      return guides[0]?.sync.status === 'idle' && guides[0].sync.lastSuccessAt ? guides[0] : null;
    });
    expect(guide).toMatchObject({ origin: 'playlist', sourceIds: [source.id], stats: { channels: 4, keptChannels: 2 } });
    expect(guide.stats.programmes).toBe(2 * 96);

    const synced = await waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${source.id}`).set(auth())).body as SourceDto;
      return current.stats.epgMapped === 2 ? current : null;
    });
    expect(synced.epg.guides).toBe(1);
    expect(synced.catalogVersion).not.toBe(`${synced.revision}.0`); // links bumped epgVersion

    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth()).expect(200)).body as ChannelListDto;
    expect(list.channels.map((c) => [c.name, c.hasEpg])).toEqual([
      ['News HD', true],
      ['UK: Sport 1 FHD', true],
      ['Mystery Channel', false],
    ]);
  });

  it('serves now/next, a channel schedule with archive flags, the guide grid and programme search', async () => {
    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth())).body as ChannelListDto;
    const [news, sport] = list.channels;

    const nowNext = (await request(t.app).get('/api/v1/epg/now').query({ sourceId: source.id }).set(auth()).expect(200)).body as NowNextListDto;
    expect(Object.keys(nowNext.items).sort()).toEqual([news!.key, sport!.key].sort());
    const entry = nowNext.items[news!.key]!;
    expect(new Date(entry.now!.start).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(entry.now!.end).getTime()).toBeGreaterThan(Date.now());
    expect(entry.next!.start).toBe(entry.now!.end);

    const schedule = (await request(t.app).get(`/api/v1/epg/channels/${source.id}/${sport!.key}`).set(auth()).expect(200)).body as ChannelScheduleDto;
    // Archive of 3 days → the schedule starts in the past and past programmes are watchable.
    const past = schedule.programmes.filter((p) => new Date(p.end).getTime() <= Date.now());
    expect(past.length).toBeGreaterThan(20);
    expect(past.every((p) => p.catchup)).toBe(true);
    const newsSchedule = (await request(t.app).get(`/api/v1/epg/channels/${source.id}/${news!.key}`).set(auth())).body as ChannelScheduleDto;
    expect(newsSchedule.programmes.some((p) => p.catchup)).toBe(false);

    const from = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    const grid = (await request(t.app)
      .get('/api/v1/epg/guide')
      .query({ sourceId: source.id, from: from.toISOString(), to: new Date(from.getTime() + 3 * HOUR).toISOString() })
      .set(auth())
      .expect(200)).body as GuideDto;
    expect(grid.total).toBe(3);
    expect(grid.rows.map((row) => row.programmes.length)).toEqual([3, 3, 0]);
    const sportsOnly = (await request(t.app)
      .get('/api/v1/epg/guide')
      .query({ sourceId: source.id, from: from.toISOString(), to: new Date(from.getTime() + HOUR).toISOString(), group: 'Sports' })
      .set(auth())).body as GuideDto;
    expect(sportsOnly.rows.map((row) => row.channel.name)).toEqual(['UK: Sport 1 FHD']);
    await request(t.app)
      .get('/api/v1/epg/guide')
      .query({ sourceId: source.id, from: from.toISOString(), to: new Date(from.getTime() + 30 * HOUR).toISOString() })
      .set(auth())
      .expect(400);

    const search = (await request(t.app).get('/api/v1/epg/search').query({ q: 'champions leag' }).set(auth()).expect(200)).body as EpgSearchResultDto;
    expect(search.items.length).toBeGreaterThan(0);
    expect(search.items.every((item) => item.channel.name === 'UK: Sport 1 FHD' && item.programme.title === 'Champions League Live')).toBe(true);
    // On air / upcoming first, then archive.
    expect(new Date(search.items[0]!.programme.end).getTime()).toBeGreaterThan(Date.now());
  });

  it('maps a channel manually to a guide channel the guide had skipped (re-syncs it), and back to automatic', async () => {
    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth())).body as ChannelListDto;
    const mystery = list.channels[2]!;
    const options = (await request(t.app).get('/api/v1/epg/guide-channels').query({ sourceId: source.id, q: 'extra' }).set(auth()).expect(200)).body as GuideChannelOptionDto[];
    expect(options.map((o) => o.id)).toEqual(['extra.ge']);

    const before = guideRequests;
    const link = (await request(t.app)
      .put('/api/v1/epg/mappings')
      .set(auth())
      .send({ sourceId: source.id, channelKey: mystery.key, guideId: options[0]!.guideId, epgChannelId: 'extra.ge' })
      .expect(200)).body as ChannelEpgLinkDto;
    expect(link.link).toMatchObject({ epgChannelId: 'extra.ge', epgChannelName: 'Extra Channel', match: 'manual' });

    // The guide is fetched again and now keeps the newly linked channel's programmes.
    await waitFor(async () => {
      const now = (await request(t.app).get('/api/v1/epg/now').query({ sourceId: source.id }).set(auth())).body as NowNextListDto;
      return now.items[mystery.key]?.now ? true : null;
    });
    expect(guideRequests).toBeGreaterThan(before);

    const reset = (await request(t.app).delete(`/api/v1/epg/mappings/${source.id}/${mystery.key}`).set(auth()).expect(200)).body as ChannelEpgLinkDto;
    expect(reset.link).toBeNull();
  });

  it('adds a manual guide for the source, and reports an unreachable guide as "EPG unavailable"', async () => {
    const manual = (await request(t.app).post('/api/v1/epg/guides').set(auth()).send({ url: `${origin.url}/manual.xml`, name: 'My XMLTV' }).expect(201)).body as GuideSourceDto;
    expect(manual).toMatchObject({ origin: 'manual', name: 'My XMLTV', sourceIds: [source.id] });
    await waitFor(async () => {
      const guides = (await request(t.app).get('/api/v1/epg/guides').set(auth())).body as GuideSourceDto[];
      return guides.find((g) => g.id === manual.id)?.sync.lastSuccessAt ? true : null;
    });
    // Announced guides are managed by their source; manual ones can be removed.
    const announced = ((await request(t.app).get('/api/v1/epg/guides').set(auth())).body as GuideSourceDto[]).find((g) => g.origin === 'playlist')!;
    await request(t.app).delete(`/api/v1/epg/guides/${announced.id}`).set(auth()).expect(409);
    await request(t.app).delete(`/api/v1/epg/guides/${manual.id}`).set(auth()).expect(204);

    guideBroken = true;
    await request(t.app).post(`/api/v1/epg/guides/${announced.id}/sync`).set(auth()).expect(202);
    const failed = await waitFor(async () => {
      const guides = (await request(t.app).get('/api/v1/epg/guides').set(auth())).body as GuideSourceDto[];
      const guide = guides.find((g) => g.id === announced.id);
      return guide?.sync.status === 'failed' ? guide : null;
    });
    expect(failed.sync.error).toContain('HTTP 500');
    // The previous generation stays readable while the guide is failing.
    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth())).body as ChannelListDto;
    const nowNext = (await request(t.app).get('/api/v1/epg/now').query({ sourceId: source.id }).set(auth())).body as NowNextListDto;
    expect(nowNext.items[list.channels[0]!.key]?.now).toBeTruthy();
    const notifications = (await request(t.app).get('/api/v1/notifications').set(auth())).body as NotificationListDto;
    expect(notifications.items.find((n) => n.type === 'epg_failed')?.title).toBe('EPG unavailable');
    guideBroken = false;
  });

  it('removes the announced guide and its programmes together with the source', async () => {
    await request(t.app).delete(`/api/v1/sources/${source.id}`).set(auth()).expect(204);
    expect((await request(t.app).get('/api/v1/epg/guides').set(auth())).body).toEqual([]);
  });
});
