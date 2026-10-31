import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newEntityId } from '../../../domain/shared/ids.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { PgGuideRepository, PgProgrammeRepository } from './repositories/epg.repository.js';
import { PgUserRepository } from './repositories/user.repository.js';

const HOUR = 3600_000;

describe.skipIf(!TEST_DATABASE_URL)('EPG persistence', () => {
  let testDb: TestDatabase;
  let guides: PgGuideRepository;
  let programmes: PgProgrammeRepository;
  let ownerId = '';

  beforeAll(async () => {
    testDb = await createTestDatabase();
    guides = new PgGuideRepository(testDb.database.db);
    programmes = new PgProgrammeRepository(testDb.database.db);
    ownerId = (await new PgUserRepository(testDb.database.db).createGuest()).id;
  });
  afterAll(async () => testDb?.close());

  const programme = (channelId: string, start: number, title: string) => ({
    channelId,
    start: new Date(start),
    stop: new Date(start + HOUR),
    title,
    subtitle: null,
    description: null,
    categories: [],
    icon: null,
    episode: null,
    rating: null,
  });

  it('every sync run reserves its own generation; the live generation is never deleted', async () => {
    const guide = await guides.create({ ownerId, name: 'G', origin: 'manual', url: 'enc', urlHash: newEntityId(), host: 'h', sourceIds: [], queuedAt: new Date() });
    const now = new Date();
    const first = await guides.claimDue(now, 'a', new Date(now.getTime() + 1_000));
    expect(first?.claimedGeneration).toBe(1);
    // A's lease lapses; B takes over and must not get A's generation.
    const later = new Date(now.getTime() + 5_000);
    const second = await guides.claimDue(later, 'b', new Date(later.getTime() + 60_000));
    expect(second?.claimedGeneration).toBe(2);

    await programmes.insertGeneration({ guideId: guide.id, generation: 2 }, [programme('x', Date.now(), 'Kept')]);
    expect(await guides.commitGeneration(guide.id, 'b', 0, 2, { channels: 1, keptChannels: 1, programmes: 1, from: null, to: null })).not.toBeNull();
    // A finally gives up and cleans "its" rows — a buggy caller asking for the live generation deletes nothing.
    await programmes.deleteGeneration({ guideId: guide.id, generation: 2 });
    expect((await programmes.window([{ guideId: guide.id, generation: 2, channelIds: ['x'] }], new Date(Date.now() - HOUR), new Date(Date.now() + 2 * HOUR))).length).toBe(1);
    // A's stale commit cannot replace B's generation.
    expect(await guides.commitGeneration(guide.id, 'a', 0, 1, { channels: 0, keptChannels: 0, programmes: 0, from: null, to: null })).toBeNull();
  });

  it('upcoming() returns what is on and what is next per channel; search orders both ways', async () => {
    const guide = await guides.create({ ownerId, name: 'H', origin: 'manual', url: 'enc', urlHash: newEntityId(), host: 'h', sourceIds: [], queuedAt: new Date() });
    const base = Math.floor(Date.now() / HOUR) * HOUR;
    const ref = { guideId: guide.id, generation: 1 };
    await programmes.insertGeneration(ref, [
      ...[-3, -2, -1, 0, 1, 2, 3].map((h) => programme('a', base + h * HOUR, `News ${h}`)),
      ...[-1, 0, 1].map((h) => programme('b', base + h * HOUR, `Sport ${h}`)),
    ]);
    const now = new Date(base + 10 * 60_000);
    const rows = await programmes.upcoming([{ ...ref, channelIds: ['a', 'b', 'missing'] }], now, 2);
    expect(rows.filter((row) => row.channelId === 'a').map((row) => row.title)).toEqual(['News 0', 'News 1']);
    expect(rows.filter((row) => row.channelId === 'b').map((row) => row.title)).toEqual(['Sport 0', 'Sport 1']);

    const desc = await programmes.search([ref], ['news'], new Date(base - 4 * HOUR), now, 2, 'desc');
    expect(desc.map((row) => row.title)).toEqual(['News 0', 'News -1']);
    const asc = await programmes.search([ref], ['news'], now, new Date(base + 5 * HOUR), 2, 'asc');
    expect(asc.map((row) => row.title)).toEqual(['News 0', 'News 1']);
  });

  it('creating the same guide URL twice (two sources at once) yields one guide', async () => {
    const urlHash = newEntityId();
    const [a, b] = await Promise.all([
      guides.create({ ownerId, name: 'A', origin: 'playlist', url: 'enc', urlHash, host: 'h', sourceIds: [], queuedAt: new Date() }),
      guides.create({ ownerId, name: 'B', origin: 'playlist', url: 'enc', urlHash, host: 'h', sourceIds: [], queuedAt: new Date() }),
    ]);
    expect(a.id).toBe(b.id);
  });
});
