import type {
  AuthSessionDto,
  ChannelListDto,
  DeviceDto,
  HomeDto,
  MasterChannelDetailDto,
  MovieDetailsDto,
  NotificationListDto,
  MoviePageDto,
  OperatorChannelListDto,
  ParentalSettingsDto,
  PlaybackPlanDto,
  PlaybackSessionDto,
  PlaylistDto,
  ProfileDto,
  ProviderDto,
  SearchResultDto,
  SourceDto,
  UnlockDto,
  VodOverviewDto,
  MovieDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newEntityId } from '../domain/shared/ids.js';
import { createLogger } from '../infrastructure/logger.js';
import { staffSession } from '../test/console.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));
const PIN = '4826';
const PASSWORD = 'correct-horse-battery-9';

function playlist(base: string): string {
  return [
    '#EXTM3U',
    '#EXTINF:-1 group-title="News",Daily News',
    `${base}/live/news.ts`,
    '#EXTINF:-1 group-title="Cartoons",Toon Time',
    `${base}/live/toons.ts`,
    '#EXTINF:-1 group-title="XXX Adults",Night Club TV',
    `${base}/live/adult.ts`,
    '#EXTINF:6000 group-title="Horror",Scary Night (2020)',
    `${base}/vod/scary.mp4`,
    '#EXTINF:5400 group-title="Family",Happy Bears (2019)',
    `${base}/vod/bears.mp4`,
  ].join('\n');
}

/**
 * Parental controls, Phase 10.5 — the gate: locked content is not handed out by any endpoint
 * without the PIN. Kids profiles are strict (locked = absent), PIN-protected profiles and the kids
 * lock live on the device session, and unlock tokens are bound to device, profile and PIN.
 */
describe.skipIf(!TEST_DATABASE_URL)('Parental controls', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let token = '';
  let source: SourceDto;
  let channels: ChannelListDto;
  let main: ProfileDto;
  let kids: ProfileDto;
  let licensed: MasterChannelDetailDto;
  let device: DeviceDto;
  const as = (profileId?: string, extra: Record<string, string> = {}, bearer = token) => ({ Authorization: `Bearer ${bearer}`, ...(profileId ? { 'X-Profile-Id': profileId } : {}), ...extra });
  const channel = (name: string) => channels.channels.find((c) => c.name === name)!;
  const play = (content: Record<string, unknown>, headers: Record<string, string>, unlockToken?: string) =>
    request(t.app)
      .post('/api/v1/playback')
      .set(headers)
      .send({ content, secureContext: false, ...(unlockToken ? { unlockToken } : {}) });
  const unlock = async (profileId: string, pin = PIN) => ((await request(t.app).post('/api/v1/me/parental/unlock').set(as(profileId)).send({ pin }).expect(200)).body as UnlockDto).token;

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/list.m3u') return void res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(playlist(`http://${req.headers.host}`));
      if (path?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      if (path?.endsWith('.mp4')) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.from('ftyp'));
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false', PROBES_ENABLED: 'false', OPERATOR_DEFAULT_COUNTRY: 'GE' });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });

    token = ((await request(t.app).post('/api/v1/auth/register').send({ email: 'parent@example.com', password: PASSWORD }).expect(201)).body as AuthSessionDto).token;
    const added = (await request(t.app).post('/api/v1/sources').set(as()).send({ type: 'm3u_url', url: `${origin.url}/list.m3u` }).expect(202)).body as SourceDto;
    source = await waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${added.id}`).set(as())).body as SourceDto;
      return current.revision === 1 && current.sync.status === 'idle' ? current : null;
    });
    channels = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(as()).expect(200)).body as ChannelListDto;
    main = ((await request(t.app).get('/api/v1/profiles').set(as()).expect(200)).body as ProfileDto[])[0]!;
    kids = (await request(t.app).post('/api/v1/profiles').set(as()).send({ name: 'Kids', kind: 'kids' }).expect(201)).body as ProfileDto;
    // A kids profile starts with an empty library: a grown-up assigns what it sees (no PIN set yet).
    await request(t.app).put(`/api/v1/profiles/${kids.id}/library`).set(as()).send({ sourceIds: [source.id] }).expect(200);

    // One licensed (FAST) operator channel.
    const content = await staffSession(t, admin, 'content@ops.example', 'CONTENT_MANAGER');
    licensed = (await request(admin).post('/admin/v1/channels').set(content.headers).send({ name: 'Late Movie', originCountry: 'GE', globalUid: 'late.tv' }).expect(201)).body as MasterChannelDetailDto;
    const provider = (await request(admin).post('/admin/v1/providers').set(content.headers).send({ name: 'Licensor', type: 'mock', config: { channels: [{ id: 'm', name: 'Late Movie', tvgId: 'late.tv', url: `${origin.url}/live/late.ts`, kind: 'mpegts' }] } }).expect(201)).body as ProviderDto;
    await waitFor(async () => (((await request(admin).get('/admin/v1/providers').set(content.headers)).body as ProviderDto[]).find((p) => p.id === provider.id)?.sync.lastSuccessAt ? true : null));
    await request(admin).post(`/admin/v1/channels/${licensed.id}/grants`).set(content.headers).send({ territory: '*', deviceClasses: ['web'], businessModels: ['fast'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'FAST-1' }).expect(201);
    device = (await request(t.app).post('/api/v1/devices').set(as()).send({ key: newEntityId() + newEntityId(), name: 'Laptop', platform: 'web' }).expect(201)).body as DeviceDto;
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  it('sets a PIN (4–8 digits, not trivial); changing it needs the current one; rules need it too', async () => {
    await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: '12' }).expect(400);
    await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: '1234' }).expect(400);
    await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: '0000' }).expect(400);
    expect((await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: '9182' }).expect(200)).body).toMatchObject({ pinSet: true });
    expect((await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: PIN }).expect(403)).body.error.code).toBe('PIN_REQUIRED');
    expect((await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ currentPin: '0001', pin: PIN }).expect(403)).body.error.code).toBe('PIN_INVALID');
    await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ currentPin: '9182', pin: PIN }).expect(200);

    // Main profile: News locked, plus the licensed channel. Kids profile: Horror locked (and adult hidden anyway).
    await request(t.app).put('/api/v1/me/parental/rules').set(as()).send({ pin: '9182', lockedGroups: [{ sourceId: source.id, group: 'News' }] }).expect(403);
    const rules = (await request(t.app)
      .put('/api/v1/me/parental/rules')
      .set(as())
      .send({ pin: PIN, lockedGroups: [{ sourceId: source.id, group: 'News' }], lockedChannels: [{ sourceId: 'operator', key: licensed.id, name: 'Late Movie' }] })
      .expect(200)).body as ParentalSettingsDto;
    expect(rules).toMatchObject({ pinSet: true, hideAdult: false, lockedGroups: [{ sourceId: source.id, group: 'News' }], lockedChannels: [{ sourceId: 'operator', key: licensed.id, name: 'Late Movie' }] });
    await request(t.app).put('/api/v1/me/parental/rules').set(as()).send({ pin: PIN, profileId: kids.id, lockedGroups: [{ sourceId: source.id, group: 'Horror' }] }).expect(200);
    await request(t.app).put('/api/v1/me/parental/rules').set(as()).send({ pin: PIN, lockedGroups: [{ sourceId: newEntityId(), group: 'X' }] }).expect(400);
  });

  it('locked content is marked, and no stream is handed out without the PIN (BYO and licensed)', async () => {
    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(as()).expect(200)).body as ChannelListDto;
    expect(list.channels.find((c) => c.name === 'Daily News')).toMatchObject({ locked: true });
    expect(list.channels.find((c) => c.name === 'Toon Time')).toMatchObject({ locked: false });
    const news = { type: 'channel', sourceId: source.id, key: channel('Daily News').key };
    expect((await play(news, as()).expect(403)).body.error.code).toBe('PARENTAL_LOCKED');

    const operator = (await request(t.app).get('/api/v1/operator/channels').set(as()).expect(200)).body as OperatorChannelListDto;
    expect(operator.channels.find((c) => c.id === licensed.id)).toMatchObject({ parentalLock: true });
    const start = (headers: Record<string, string>) => request(t.app).post('/api/v1/operator/playback/sessions').set(headers).send({ channelId: licensed.id, deviceId: device.id, secureContext: false });
    expect((await start(as()).expect(403)).body.error.code).toBe('PARENTAL_LOCKED');

    await request(t.app).post('/api/v1/me/parental/unlock').set(as()).send({ pin: '5555' }).expect(403);
    const unlocked = await unlock(main.id);
    const plan = (await play(news, as(), unlocked).expect(200)).body as PlaybackPlanDto;
    expect(plan.content.title).toBe('Daily News');
    expect((await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(as(undefined, { 'X-Unlock-Token': unlocked })).expect(200)).body.channels.find((c: { name: string }) => c.name === 'Daily News')).toMatchObject({ locked: false });
    const session = (await start(as(undefined, { 'X-Unlock-Token': unlocked })).expect(201)).body as PlaybackSessionDto;
    await request(t.app).delete(`/api/v1/operator/playback/sessions/${session.playbackSessionId}`).set(as()).expect(204);

    // A token is bound to its profile and device: elsewhere it unlocks nothing.
    const other = (await request(t.app).post('/api/v1/profiles').set(as()).send({ name: 'Guest' }).expect(201)).body as ProfileDto;
    await request(t.app).put('/api/v1/me/parental/rules').set(as()).send({ pin: PIN, profileId: other.id, lockedGroups: [{ sourceId: source.id, group: 'News' }] }).expect(200);
    expect((await play(news, as(other.id), unlocked).expect(403)).body.error.code).toBe('PARENTAL_LOCKED');
    const secondDevice = ((await request(t.app).post('/api/v1/auth/login').send({ email: 'parent@example.com', password: PASSWORD }).expect(200)).body as AuthSessionDto).token;
    expect((await play(news, as(undefined, {}, secondDevice), unlocked).expect(403)).body.error.code).toBe('PARENTAL_LOCKED');
    await request(t.app).delete(`/api/v1/profiles/${other.id}`).set(as()).send({ pin: PIN }).expect(204);
  });

  it('kids profiles: adult and locked content does not exist — lists, VOD, search, Home, details, playback', async () => {
    const kidsHeaders = as(kids.id);
    const list = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(kidsHeaders).expect(200)).body as ChannelListDto;
    expect(list.channels.map((c) => c.name).sort()).toEqual(['Daily News', 'Toon Time']); // News is locked for the main profile only
    const movies = (await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name`).set(kidsHeaders).expect(200)).body as MoviePageDto;
    expect(movies.items.map((m) => m.name)).toEqual(['Happy Bears']);
    expect(movies.total).toBe(1);
    const overview = (await request(t.app).get(`/api/v1/vod/${source.id}/movies/overview`).set(kidsHeaders).expect(200)).body as VodOverviewDto<MovieDto>;
    expect(overview.categories.map((c) => c.name)).toEqual(['Family']);
    const search = (await request(t.app).get('/api/v1/search?q=night').set(kidsHeaders).expect(200)).body as SearchResultDto;
    expect([...search.channels, ...search.movies]).toEqual([]);
    const home = (await request(t.app).get('/api/v1/home').set(kidsHeaders).expect(200)).body as HomeDto;
    expect(JSON.stringify(home)).not.toMatch(/Scary Night|Night Club/);

    const scary = ((await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name`).set(as()).expect(200)).body as MoviePageDto).items.find((m) => m.name === 'Scary Night')!;
    await request(t.app).get(`/api/v1/vod/${source.id}/movies/${scary.key}`).set(kidsHeaders).expect(404);
    expect(((await request(t.app).get(`/api/v1/vod/${source.id}/movies/${scary.key}`).set(as()).expect(200)).body as MovieDetailsDto).name).toBe('Scary Night');
    await play({ type: 'movie', sourceId: source.id, key: scary.key }, kidsHeaders).expect(404);
    await play({ type: 'channel', sourceId: source.id, key: channel('Night Club TV').key }, kidsHeaders).expect(404);

    // The PIN never unlocks anything in a kids profile, and kids cannot change the rules.
    expect((await request(t.app).post('/api/v1/me/parental/unlock').set(kidsHeaders).send({ pin: PIN }).expect(403)).body.error.details).toMatchObject({ reason: 'kids_profile' });
    await request(t.app).put('/api/v1/me/parental/rules').set(kidsHeaders).send({ pin: PIN, lockedGroups: [] }).expect(403);
    await request(t.app).delete('/api/v1/me/parental/pin').set(kidsHeaders).send({ pin: PIN }).expect(403);
    // …nor bring in content or buy anything.
    await request(t.app).post('/api/v1/sources').set(kidsHeaders).send({ type: 'm3u_url', url: `${origin.url}/list.m3u` }).expect(403);
    await request(t.app).get('/api/v1/playlists').set(kidsHeaders).expect(403);
    await request(t.app).get(`/api/v1/sources/${source.id}`).set(kidsHeaders).expect(200);
  });

  it('security notices reach the grown-ups, not the kids profile; read ones can be cleared', async () => {
    const mine = (await request(t.app).get('/api/v1/notifications').set(as()).expect(200)).body as NotificationListDto;
    expect(mine.items.map((item) => item.title)).toEqual(expect.arrayContaining(['Parental PIN set', 'Parental PIN changed']));
    const theirs = (await request(t.app).get('/api/v1/notifications').set(as(kids.id)).expect(200)).body as NotificationListDto;
    expect(theirs.items.some((item) => item.type === 'account_security')).toBe(false);
    await request(t.app).post('/api/v1/notifications/read').set(as(kids.id)).send({ ids: 'all' }).expect(204);
    expect(((await request(t.app).get('/api/v1/notifications').set(as()).expect(200)).body as NotificationListDto).items.filter((item) => item.type === 'account_security').every((item) => !item.read)).toBe(true);
    await request(t.app).post('/api/v1/notifications/read').set(as()).send({ ids: 'all' }).expect(204);
    expect(((await request(t.app).delete('/api/v1/notifications').set(as()).expect(200)).body as { removed: number }).removed).toBeGreaterThanOrEqual(2);
    expect(((await request(t.app).get('/api/v1/notifications').set(as()).expect(200)).body as NotificationListDto).items).toEqual([]);
  });

  it('a device that enters the kids profile stays there until the PIN is given', async () => {
    const tablet = ((await request(t.app).post('/api/v1/auth/login').send({ email: 'parent@example.com', password: PASSWORD }).expect(200)).body as AuthSessionDto).token;
    const on = (profileId?: string) => as(profileId, {}, tablet);
    await request(t.app).post(`/api/v1/profiles/${kids.id}/access`).set(on()).send({}).expect(200);
    // Without X-Profile-Id the device is in the kids profile; any other profile is refused.
    const viaDefault = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(on()).expect(200)).body as ChannelListDto;
    expect(viaDefault.channels.map((c) => c.name)).not.toContain('Night Club TV');
    expect((await request(t.app).get('/api/v1/home').set(on(main.id)).expect(403)).body.error).toMatchObject({ code: 'PIN_REQUIRED', details: { reason: 'kids_lock', profileId: kids.id } });
    // Profile changes a child could use to escape need the PIN.
    expect((await request(t.app).patch(`/api/v1/profiles/${kids.id}`).set(on()).send({ kind: 'standard' }).expect(403)).body.error.code).toBe('PIN_REQUIRED');
    await request(t.app).post('/api/v1/profiles').set(on()).send({ name: 'Sneaky' }).expect(403);
    await request(t.app).patch(`/api/v1/profiles/${kids.id}`).set(on()).send({ name: 'Little ones' }).expect(200);

    expect((await request(t.app).post(`/api/v1/profiles/${main.id}/access`).set(on()).send({}).expect(403)).body.error.code).toBe('PIN_REQUIRED');
    await request(t.app).post(`/api/v1/profiles/${main.id}/access`).set(on()).send({ pin: '1111' }).expect(403);
    await request(t.app).post(`/api/v1/profiles/${main.id}/access`).set(on()).send({ pin: PIN }).expect(200);
    await request(t.app).get('/api/v1/home').set(on(main.id)).expect(200);
    await request(t.app).get('/api/v1/home').set(on()).expect(200); // default profile again
  });

  it('a PIN-protected profile opens on a device only with the PIN', async () => {
    await request(t.app).patch(`/api/v1/profiles/${main.id}`).set(as()).send({ pinProtected: true }).expect(403);
    expect(((await request(t.app).patch(`/api/v1/profiles/${main.id}`).set(as()).send({ pinProtected: true, pin: PIN }).expect(200)).body as ProfileDto).pinProtected).toBe(true);
    const phone = ((await request(t.app).post('/api/v1/auth/login').send({ email: 'parent@example.com', password: PASSWORD }).expect(200)).body as AuthSessionDto).token;
    expect((await request(t.app).get('/api/v1/me/list').set(as(undefined, {}, phone)).expect(403)).body.error.details).toMatchObject({ reason: 'profile_locked', profileId: main.id });
    // The profile chooser still works (account-level routes).
    expect(((await request(t.app).get('/api/v1/profiles').set(as(undefined, {}, phone)).expect(200)).body as ProfileDto[]).length).toBe(2);
    await request(t.app).post(`/api/v1/profiles/${main.id}/access`).set(as(undefined, {}, phone)).send({}).expect(403);
    await request(t.app).post(`/api/v1/profiles/${main.id}/access`).set(as(undefined, {}, phone)).send({ pin: PIN }).expect(200);
    await request(t.app).get('/api/v1/me/list').set(as(undefined, {}, phone)).expect(200);
  });

  it('export links play outside the app, so creating one needs the PIN', async () => {
    const playlistDto = (await request(t.app).post('/api/v1/playlists').set(as()).send({ name: 'Mine' }).expect(201)).body as PlaylistDto;
    expect((await request(t.app).post(`/api/v1/playlists/${playlistDto.id}/export`).set(as()).expect(403)).body.error.code).toBe('PIN_REQUIRED');
    await request(t.app).post(`/api/v1/playlists/${playlistDto.id}/export`).set(as(undefined, { 'X-Unlock-Token': await unlock(main.id) })).expect(200);
  });

  it('wrong PINs lock the PIN for a while — even the right one is refused meanwhile', async () => {
    const other = ((await request(t.app).post('/api/v1/auth/register').send({ email: 'guesser@example.com', password: PASSWORD }).expect(201)).body as AuthSessionDto).token;
    const headers = { Authorization: `Bearer ${other}` };
    await request(t.app).put('/api/v1/me/parental/pin').set(headers).send({ pin: '7319' }).expect(200);
    for (let attempt = 0; attempt < 4; attempt++) await request(t.app).post('/api/v1/me/parental/unlock').set(headers).send({ pin: '0000' }).expect(403);
    expect((await request(t.app).post('/api/v1/me/parental/unlock').set(headers).send({ pin: '0000' }).expect(429)).body.error.details).toMatchObject({ reason: 'pin_locked' });
    await request(t.app).post('/api/v1/me/parental/unlock').set(headers).send({ pin: '7319' }).expect(429);
  });

  it('removing the PIN removes the locks and protections with it', async () => {
    const before = await unlock(main.id);
    await request(t.app).delete('/api/v1/me/parental/pin').set(as()).send({ pin: '0002' }).expect(403);
    expect((await request(t.app).delete('/api/v1/me/parental/pin').set(as()).send({ pin: PIN }).expect(200)).body).toMatchObject({ pinSet: false, lockedGroups: [], lockedChannels: [] });
    await play({ type: 'channel', sourceId: source.id, key: channel('Daily News').key }, as()).expect(200);
    expect(((await request(t.app).get('/api/v1/profiles').set(as()).expect(200)).body as ProfileDto[]).every((p) => !p.pinProtected)).toBe(true);

    // The same PIN set again does not revive unlocks made before it was removed.
    await request(t.app).put('/api/v1/me/parental/pin').set(as()).send({ pin: PIN }).expect(200);
    await request(t.app).put('/api/v1/me/parental/rules').set(as()).send({ pin: PIN, lockedGroups: [{ sourceId: source.id, group: 'News' }] }).expect(200);
    expect((await play({ type: 'channel', sourceId: source.id, key: channel('Daily News').key }, as(), before).expect(403)).body.error.code).toBe('PARENTAL_LOCKED');
  });
});
