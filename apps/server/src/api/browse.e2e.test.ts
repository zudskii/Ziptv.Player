import type { MovieDto, ProfileDto, SeriesDto, SessionDto, SourceDto, VodBrowsePageDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, TEST_DATABASE_URL, type TestApp } from '../test/harness.js';

/**
 * GET /browse/movies|series (Phase 15) over HTTP: one list across the profile's library, filters
 * and facets, keyset cursors, validation, and the profile rules (library, adult, kids).
 */

const movies = (prefix: string, base: string) =>
  [
    '#EXTM3U',
    `#EXTINF:5400 group-title="EN | Action Movies",${prefix} Heist (1999)`,
    `${base}/${prefix}-1.mp4`,
    `#EXTINF:7800 group-title="EN | Action Movies",${prefix} Chase (2004)`,
    `${base}/${prefix}-2.mp4`,
    `#EXTINF:6000 group-title="Комедии",${prefix} Laughs (2015)`,
    `${base}/${prefix}-3.mp4`,
    `#EXTINF:6000 group-title="XXX Adult",${prefix} Late Night (2010)`,
    `${base}/${prefix}-4.mp4`,
  ].join('\n');

describe.skipIf(!TEST_DATABASE_URL)('Browse API', () => {
  let t: TestApp;
  let token = '';
  let bob: ProfileDto;
  let kids: ProfileDto;
  let alpha: SourceDto;
  let beta: SourceDto;
  const auth = (profileId?: string) => ({ Authorization: `Bearer ${token}`, ...(profileId ? { 'X-Profile-Id': profileId } : {}) });
  const browse = async <T = MovieDto,>(path: string, profileId?: string, status = 200) =>
    (await request(t.app).get(`/api/v1/browse/${path}`).set(auth(profileId)).expect(status)).body as VodBrowsePageDto<T>;
  const upload = async (name: string, text: string, profileId?: string) =>
    (await request(t.app).post('/api/v1/sources/upload').set(auth(profileId)).field('name', name).attach('file', Buffer.from(text), `${name}.m3u`).expect(201)).body as SourceDto;

  beforeAll(async () => {
    t = await startTestApp();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    bob = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Bob' }).expect(201)).body as ProfileDto;
    kids = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Kids', kind: 'kids' }).expect(201)).body as ProfileDto;
    alpha = await upload('Alpha', movies('Alpha', 'http://example.com/a'));
    beta = await upload('Beta', movies('Beta', 'http://example.com/b'), bob.id); // Bob's only
  });
  afterAll(async () => {
    await t?.close();
  });

  it("lists the profile's whole library with facets; other profiles' sources are not part of it", async () => {
    const page = await browse('movies?facets=1');
    expect(page.items.every((item) => item.sourceId === alpha.id)).toBe(true);
    expect(page.total).toBe(4);
    expect(page.facets!.sources).toEqual([{ sourceId: alpha.id, count: 4 }]);
    expect(page.facets!.genres.find((genre) => genre.id === 'action')?.count).toBe(2);
    expect(page.facets!.genres.find((genre) => genre.id === 'comedy')?.count).toBe(1);
    expect(page.facets!.decades.map((decade) => decade.decade)).toEqual([2010, 2000, 1990]);
    // Asking for a source outside the library gives nothing (not someone else's movies).
    expect((await browse(`movies?sources=${beta.id}`)).total).toBe(0);
    expect((await browse('movies', bob.id)).items.every((item) => item.sourceId === beta.id)).toBe(true);
  });

  it('filters combine; cursors page through without repeats', async () => {
    const action = await browse('movies?genres=action&sort=year');
    expect(action.items.map((item) => item.name)).toEqual(['Alpha Chase', 'Alpha Heist']);
    expect((await browse('movies?genres=action&length=long')).items.map((item) => item.name)).toEqual(['Alpha Chase']);
    expect((await browse('movies?yearMin=2000&yearMax=2012&sort=name')).items.map((item) => item.name)).toEqual(['Alpha Chase', 'Alpha Late Night']);
    expect((await browse('movies?q=hei')).items.map((item) => item.name)).toEqual(['Alpha Heist']);
    expect((await browse('movies?genres=popcorn,comedy')).total).toBe(1); // unknown genre ids are ignored

    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page: VodBrowsePageDto<MovieDto> = await browse(`movies?sort=name&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      names.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(names).toEqual(['Alpha Chase', 'Alpha Heist', 'Alpha Late Night', 'Alpha Laughs']);
  });

  it('rejects what it cannot answer', async () => {
    await browse('movies?cursor=not-a-cursor', undefined, 400);
    const first = await browse('movies?sort=name&limit=1');
    await browse(`movies?sort=year&cursor=${first.nextCursor}`, undefined, 400); // a cursor belongs to its sort
    await browse('movies?added=5', undefined, 400);
    await browse('movies?yearMin=2010&yearMax=2000', undefined, 400);
    await browse('movies?unknown=1', undefined, 400);
    await browse<SeriesDto>('series?watch=finished', undefined, 400);
    await browse<SeriesDto>('series?length=long', undefined, 400);
    expect((await browse<SeriesDto>('series')).total).toBe(0);
  });

  it('adult items are left out where the profile hides them; kids see only their library', async () => {
    expect((await browse('movies', kids.id)).total).toBe(0); // empty library
    await request(t.app).put(`/api/v1/profiles/${kids.id}/library`).set(auth()).send({ sourceIds: [alpha.id] }).expect(200);
    const forKids = await browse('movies?facets=1', kids.id);
    expect(forKids.items.map((item) => item.name).sort()).toEqual(['Alpha Chase', 'Alpha Heist', 'Alpha Laughs']);
    expect(forKids.facets!.sources).toEqual([{ sourceId: alpha.id, count: 3 }]);
  });
});
