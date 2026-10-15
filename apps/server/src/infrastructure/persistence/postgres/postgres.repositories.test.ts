import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NewSource } from '../../../application/ports/source-repository.js';
import type { LiveChannelEntry } from '../../../domain/catalog/model.js';
import { newEntityId } from '../../../domain/shared/ids.js';
import { toStoredRevision } from '../../../application/sources/catalog-storage.js';
import { SourceSecrets } from '../../../application/sources/secrets.js';
import { AesSecretCipher, parseEncryptionKey } from '../../crypto/secret-cipher.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { MIGRATIONS } from './migrations/index.js';
import { migrateToLatest } from './migrator.js';
import { PgCatalogRepository } from './repositories/catalog.repository.js';
import { PgNotificationRepository } from './repositories/notification.repository.js';
import { PgScheduleRepository } from './repositories/schedule.repository.js';
import { PgSessionRepository } from './repositories/session.repository.js';
import { PgAccountDataTransfer } from './repositories/account-data-transfer.js';
import { PgSourceRepository } from './repositories/source.repository.js';
import { PgUserRepository } from './repositories/user.repository.js';

/** Real PostgreSQL: the queries the end-to-end suite does not hit directly (leases, upserts, bulk writes). */
describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL repositories', () => {
  let testDb: TestDatabase;
  let users: PgUserRepository;
  let sessions: PgSessionRepository;
  let sources: PgSourceRepository;
  let catalog: PgCatalogRepository;
  let notifications: PgNotificationRepository;
  let schedules: PgScheduleRepository;
  let ownerId: string;
  const secrets = new SourceSecrets(new AesSecretCipher(parseEncryptionKey('k'.repeat(40)), []));
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return logger; } } as never;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const { db } = testDb.database;
    users = new PgUserRepository(db);
    sessions = new PgSessionRepository(db);
    sources = new PgSourceRepository(db);
    catalog = new PgCatalogRepository(db);
    notifications = new PgNotificationRepository(db);
    schedules = new PgScheduleRepository(db);
    ownerId = (await users.createGuest()).id;
  });
  afterAll(async () => testDb?.close());

  const newSource = (overrides: Partial<NewSource> = {}): NewSource => ({
    id: sources.newId(),
    ownerId,
    name: 'Test source',
    type: 'm3u_url',
    origin: { kind: 'url', host: 'example.com' },
    credential: null,
    sync: { status: 'queued', stage: null, autoSync: true, intervalHours: 6, lastAttemptAt: null, lastSuccessAt: null, nextSyncAt: new Date(0), error: null, consecutiveFailures: 0, rerunRequested: false },
    ...overrides,
  });

  const channel = (index: number): LiveChannelEntry => ({
    key: `${index.toString(16).padStart(12, '0')}`,
    position: index,
    name: `Channel ${index}`,
    groups: index % 2 ? ['News', 'HD'] : [],
    logo: null,
    tvgId: index % 3 ? `tvg.${index}` : null,
    tvgName: null,
    kind: 'hls',
    unplayableReason: null,
    locator: { url: `http://example.com/${index}.m3u8`, headers: {} },
    catchup: index % 5 === 0 ? { mode: 'shift', days: 3, template: null } : null,
    adult: false,
    xtream: null,
    addedAt: null,
    epg: null,
  });

  it('applies migrations once and is idempotent', async () => {
    expect(await migrateToLatest(testDb.database.db, logger)).toEqual([]);
  });

  describe('users and accounts', () => {
    it('creates guests and accounts; emails are unique', async () => {
      const guest = await users.createGuest();
      expect(guest).toMatchObject({ email: null, role: 'user' });

      const account = await users.createAccount({ email: 'a@example.com', passwordHash: 'h1' });
      expect(account).toMatchObject({ email: 'a@example.com' });
      expect(await users.createAccount({ email: 'a@example.com', passwordHash: 'h2' })).toBeNull();
      expect((await users.findByEmail('a@example.com'))?.passwordHash).toBe('h1');
      expect(await users.findByEmail('missing@example.com')).toBeNull();
    });

    it('stores only normalised emails and complete accounts (database-level guards)', async () => {
      const { db } = testDb.database;
      await expect(users.createAccount({ email: 'Upper@Example.com', passwordHash: 'h' })).rejects.toThrow(/users_email_is_normalised/);
      await expect(db.insertInto('users').values({ id: newEntityId(), email: 'half@example.com', password_hash: null, legacy_secret_id: null }).execute()).rejects.toThrow(/users_account_is_complete/);
    });

    it('turns a guest into an account in place, once, and never steals a taken email', async () => {
      const guest = await users.createGuest();
      const promoted = await users.promoteGuest(guest.id, { email: 'p@example.com', passwordHash: 'h' });
      expect(promoted).toMatchObject({ id: guest.id, email: 'p@example.com' });
      // Already an account: not a guest any more.
      expect(await users.promoteGuest(guest.id, { email: 'other@example.com', passwordHash: 'h' })).toBeNull();
      // Email taken by someone else.
      const second = await users.createGuest();
      expect(await users.promoteGuest(second.id, { email: 'p@example.com', passwordHash: 'h' })).toBeNull();
      expect((await users.findById(second.id))?.email).toBeNull();
    });

    it('changes passwords only for accounts, exchanges a legacy id exactly once, and deletes with cascades', async () => {
      const account = (await users.createAccount({ email: 'pw@example.com', passwordHash: 'old' }))!;
      await users.setPassword(account.id, 'new');
      expect((await users.findByEmail('pw@example.com'))?.passwordHash).toBe('new');

      const guest = await users.createGuest();
      await users.setPassword(guest.id, 'sneaky'); // no-op for guests (CHECK would reject a half account)
      expect((await users.findById(guest.id))?.email).toBeNull();

      await testDb.database.db.updateTable('users').set({ legacy_secret_id: 'id123' }).where('id', '=', guest.id).execute();
      expect((await users.claimLegacy('id123'))?.id).toBe(guest.id);
      expect(await users.claimLegacy('id123')).toBeNull();

      const source = await sources.create({ ...newSource(), ownerId: account.id });
      await sessions.create({ id: sources.newId(), userId: account.id, tokenHash: 'del-token', expiresAt: null, userAgent: null, createdAt: new Date() });
      expect(await users.delete(account.id)).toBe(true);
      expect(await sources.findById(source.id)).toBeNull();
      expect(await sessions.findByTokenHash('del-token')).toBeNull();
      expect(await users.delete(account.id)).toBe(false);
    });
  });

  describe('sessions', () => {
    it('finds a session with its user, lists devices and revokes them', async () => {
      const user = (await users.createAccount({ email: 's@example.com', passwordHash: 'h' }))!;
      const expiresAt = new Date(Date.now() + 3600_000);
      const a = await sessions.create({ id: sources.newId(), userId: user.id, tokenHash: 'tok-a', expiresAt, userAgent: 'Firefox', createdAt: new Date() });
      const b = await sessions.create({ id: sources.newId(), userId: user.id, tokenHash: 'tok-b', expiresAt: null, userAgent: null, createdAt: new Date() });

      const found = await sessions.findByTokenHash('tok-a');
      expect(found?.session).toMatchObject({ id: a.id, userId: user.id, userAgent: 'Firefox' });
      expect(found?.session.expiresAt).toEqual(expiresAt);
      expect(found?.user).toMatchObject({ id: user.id, email: 's@example.com', role: 'user' });
      expect(await sessions.findByTokenHash('nope')).toBeNull();
      expect((await sessions.listForUser(user.id)).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

      const other = await users.createGuest();
      expect(await sessions.deleteOwned(other.id, a.id)).toBe(false); // someone else's device
      await sessions.deleteForUser(user.id, b.id);
      expect((await sessions.listForUser(user.id)).map((s) => s.id)).toEqual([b.id]);
      expect(await sessions.deleteOwned(user.id, b.id)).toBe(true);
    });

    it('slides the expiry on activity and purges only expired sessions', async () => {
      const user = await users.createGuest();
      const past = new Date(Date.now() - 1000);
      const future = new Date(Date.now() + 3600_000);
      const expired = await sessions.create({ id: sources.newId(), userId: user.id, tokenHash: 'exp', expiresAt: past, userAgent: null, createdAt: new Date() });
      const live = await sessions.create({ id: sources.newId(), userId: user.id, tokenHash: 'live', expiresAt: future, userAgent: null, createdAt: new Date() });
      const forever = await sessions.create({ id: sources.newId(), userId: user.id, tokenHash: 'forever', expiresAt: null, userAgent: null, createdAt: new Date() });

      const later = new Date(Date.now() + 7200_000);
      await sessions.touch(live.id, user.id, new Date(), later);
      expect((await sessions.findByTokenHash('live'))?.session.expiresAt).toEqual(later);

      expect(await sessions.purgeExpired(new Date())).toBeGreaterThanOrEqual(1);
      expect(await sessions.findByTokenHash('exp')).toBeNull();
      expect(expired.id).toBeTruthy();
      expect(await sessions.findByTokenHash('live')).not.toBeNull();
      expect((await sessions.findByTokenHash('forever'))?.session.id).toBe(forever.id);
    });
  });

  describe('merging a guest into an account', () => {
    it('moves the guest’s sources, deletes the guest, and refuses to absorb an account', async () => {
      const transfer = new PgAccountDataTransfer(testDb.database.db);
      const guest = await users.createGuest();
      const account = (await users.createAccount({ email: 'merge@example.com', passwordHash: 'h' }))!;
      const own = await sources.create({ ...newSource(), ownerId: account.id });
      const moved = await sources.create({ ...newSource(), ownerId: guest.id });
      await sessions.create({ id: sources.newId(), userId: guest.id, tokenHash: 'guest-tok', expiresAt: null, userAgent: null, createdAt: new Date() });

      expect(await transfer.mergeGuestInto(account.id, guest.id)).toBe(false); // an account is never absorbed
      expect(await transfer.mergeGuestInto(guest.id, account.id)).toBe(true);
      expect((await sources.listByOwner(account.id)).map((s) => s.id).sort()).toEqual([own.id, moved.id].sort());
      expect(await users.findById(guest.id)).toBeNull();
      expect(await sessions.findByTokenHash('guest-tok')).toBeNull();
      expect(await transfer.mergeGuestInto(guest.id, account.id)).toBe(false); // already gone
    });
  });

  describe('source leases', () => {
    it('never hands the same queued source to two claimers', async () => {
      const created = await sources.create(newSource());
      const now = new Date();
      const until = new Date(now.getTime() + 60_000);
      // Fifteen workers race for one due source: exactly one wins.
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => sources.claimDue(now, `worker-${i}`, until)));
      const winnerIndex = results.findIndex((record) => record?.id === created.id);
      expect(results.filter((record) => record?.id === created.id)).toHaveLength(1);
      expect(results[winnerIndex]?.sync.status).toBe('running');
      // Only the winner's lease can complete it.
      expect(await sources.completeSync(created.id, 'someone-else', { status: 'idle', error: null, nextSyncAt: null, consecutiveFailures: 0 })).toBeNull();
      const done = await sources.completeSync(created.id, `worker-${winnerIndex}`, { status: 'idle', error: null, nextSyncAt: null, consecutiveFailures: 0 });
      expect(done?.sync.status).toBe('idle');
    });

    it('re-queues a source whose lease expired, and a rerun request survives completion', async () => {
      const created = await sources.create(newSource({ sync: { ...newSource().sync, status: 'idle', nextSyncAt: null, autoSync: false } }));
      const t0 = new Date();
      expect(await sources.claim(created.id, t0, 'a', new Date(t0.getTime() + 1_000))).not.toBeNull();
      // Held by "a": a second claim fails, "Sync now" only flags a rerun.
      expect(await sources.claim(created.id, t0, 'b', new Date(t0.getTime() + 1_000))).toBeNull();
      expect((await sources.requestSync(created.id, t0))?.sync.rerunRequested).toBe(true);
      expect(await sources.heartbeat(created.id, 'b', new Date(t0.getTime() + 5_000))).toBe(false);
      expect(await sources.heartbeat(created.id, 'a', new Date(t0.getTime() + 5_000))).toBe(true);

      const done = await sources.completeSync(created.id, 'a', { status: 'idle', error: null, nextSyncAt: null, consecutiveFailures: 0, lastSuccessAt: t0 });
      expect(done?.sync.status).toBe('queued'); // the rerun
      expect(done?.sync.rerunRequested).toBe(false);

      // A dead lease (expired) can be taken over.
      const later = new Date(t0.getTime() + 10 * 60_000);
      expect(await sources.claim(created.id, later, 'c', new Date(later.getTime() + 1_000))).not.toBeNull();
      expect(await sources.claim(created.id, new Date(later.getTime() + 5_000), 'd', new Date(later.getTime() + 9_000))).not.toBeNull();
    });

    it('commits a revision only for the lease owner at the expected revision', async () => {
      const created = await sources.create(newSource({ sync: { ...newSource().sync, status: 'idle', nextSyncAt: null } }));
      const now = new Date();
      await sources.claim(created.id, now, 'owner', new Date(now.getTime() + 60_000));
      const snapshot = { revision: 1, stats: { live: 1, movies: 0, series: 0, episodes: 0, groups: 0, unplayable: 0, catchup: 0, epgMapped: 0 }, epgUrls: ['sealed'], warnings: [{ line: 1, code: 'x', message: 'm' }], warningCount: 1, format: 'm3u', encoding: 'utf-8', account: null, xtreamCandidate: false };
      expect(await sources.commitRevision(created.id, 'intruder', 0, snapshot)).toBeNull();
      expect(await sources.commitRevision(created.id, 'owner', 5, snapshot)).toBeNull();
      const committed = await sources.commitRevision(created.id, 'owner', 0, snapshot);
      expect(committed).toMatchObject({ revision: 1, epgUrls: ['sealed'], warningCount: 1, stats: { live: 1 } });
      expect(committed?.warnings).toEqual([{ line: 1, code: 'x', message: 'm' }]);
    });

    it('keeps timestamps and account expiry as dates', async () => {
      const created = await sources.create(newSource());
      const expiresAt = new Date('2030-01-02T03:04:05.000Z');
      await sources.updateAccount(created.id, { status: 'Active', expiresAt, maxConnections: 2, activeConnections: 0, trial: false });
      await sources.updateHealth(created.id, { state: 'online', checkedAt: new Date('2026-01-01T00:00:00.000Z'), latencyMs: 12, unstableStreams: 0, offlineStreams: 0, message: null });
      const found = await sources.findById(created.id);
      expect(found?.account?.expiresAt).toEqual(expiresAt);
      expect(found?.health.checkedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(found?.createdAt).toBeInstanceOf(Date);
    });

    it('scopes reads and deletes to the owner', async () => {
      const other = await users.createGuest();
      const created = await sources.create(newSource());
      expect(await sources.findOwned(created.id, other.id)).toBeNull();
      expect(await sources.findOwned('not-a-uuid', ownerId)).toBeNull();
      expect(await sources.deleteOwned(created.id, other.id)).toBe(false);
      expect(await sources.deleteOwned(created.id, ownerId)).toBe(true);
    });
  });

  describe('catalog', () => {
    it('stores a large revision (beyond the bind-parameter limit) and reads it back pinned', async () => {
      const source = await sources.create(newSource());
      const entries = Array.from({ length: 6_000 }, (_, index) => channel(index));
      const data = toStoredRevision({ live: entries, movies: [], series: [], episodes: [] }, secrets);
      await catalog.insertRevision(source.id, 1, data);

      const list = await catalog.listLive({ sourceId: source.id, revision: 1 });
      expect(list).toHaveLength(6_000);
      expect(list[0]?.position).toBe(0);
      expect(list[5_999]?.name).toBe('Channel 5999');
      expect(list[1]).toMatchObject({ groups: ['News', 'HD'], tvgId: 'tvg.1', catchup: null, epg: null });
      expect(list[5]?.catchup).toEqual({ mode: 'shift', days: 3, template: null });

      const stored = await catalog.findLive({ sourceId: source.id, revision: 1 }, list[7]!.key);
      expect(secrets.openLocator(stored!.locator)?.url).toBe('http://example.com/7.m3u8');
      expect(await catalog.findLive({ sourceId: source.id, revision: 2 }, list[7]!.key)).toBeNull();
    });

    it('swaps revisions: the new one is written next to the old, then the old is collected', async () => {
      const source = await sources.create(newSource());
      const toData = (count: number) => toStoredRevision({ live: Array.from({ length: count }, (_, i) => channel(i)), movies: [], series: [], episodes: [] }, secrets);
      await catalog.insertRevision(source.id, 1, toData(3));
      await catalog.insertRevision(source.id, 2, toData(5));
      expect(await catalog.listLive({ sourceId: source.id, revision: 1 })).toHaveLength(3);
      await catalog.deleteOtherRevisions(source.id, 2);
      expect(await catalog.listLive({ sourceId: source.id, revision: 1 })).toHaveLength(0);
      expect(await catalog.listLive({ sourceId: source.id, revision: 2 })).toHaveLength(5);
      // A failed insert leaves nothing behind (duplicate key in the same revision).
      await expect(catalog.insertRevision(source.id, 3, toStoredRevision({ live: [channel(1), channel(1)], movies: [], series: [], episodes: [] }, secrets))).rejects.toThrow();
      expect(await catalog.listLive({ sourceId: source.id, revision: 3 })).toHaveLength(0);
    });

    it('updates EPG links in bulk and finds the same channel in other sources', async () => {
      const a = await sources.create(newSource());
      const b = await sources.create(newSource());
      const entries = [channel(1), channel(2), channel(3)];
      await catalog.insertRevision(a.id, 1, toStoredRevision({ live: entries, movies: [], series: [], episodes: [] }, secrets));
      await catalog.insertRevision(b.id, 1, toStoredRevision({ live: [{ ...channel(9), name: 'Channel 2', key: 'bbbbbbbbbbbb' }], movies: [], series: [], episodes: [] }, secrets));

      const ref = { sourceId: a.id, revision: 1 };
      const link = { guideId: 'g1', epgChannelId: 'one', match: 'tvg-id' as const };
      await catalog.setLiveEpgLinks(ref, [{ key: entries[0]!.key, epg: link }, { key: entries[1]!.key, epg: link }]);
      await catalog.setLiveEpgLinks(ref, [{ key: entries[1]!.key, epg: null }]);
      const targets = await catalog.liveLinkTargets(ref);
      expect(targets.find((t) => t.key === entries[0]!.key)?.epg).toEqual(link);
      expect(targets.find((t) => t.key === entries[1]!.key)?.epg).toBeNull();

      const nameKey = targets.find((t) => t.key === entries[1]!.key)!.nameKey;
      const found = await catalog.findLiveByNameKey([{ sourceId: b.id, revision: 1 }, ref], nameKey, 10);
      expect(found.map((item) => item.sourceId).sort()).toEqual([a.id, b.id].sort());
    });

    it('is removed with its source', async () => {
      const source = await sources.create(newSource());
      await catalog.insertRevision(source.id, 1, toStoredRevision({ live: [channel(1)], movies: [], series: [], episodes: [] }, secrets));
      await sources.deleteOwned(source.id, ownerId);
      expect(await catalog.listLive({ sourceId: source.id, revision: 1 })).toHaveLength(0);
    });
  });

  describe('notifications', () => {
    const base = { type: 'source_failed' as const, severity: 'error' as const, body: null, link: '/sources' };

    it('refreshes an unread notification with the same dedupe key instead of stacking', async () => {
      const owner = (await users.createGuest()).id;
      const first = await notifications.upsert({ ...base, ownerId: owner, title: 'First', dedupeKey: 'k' }, new Date('2026-01-01T00:00:00Z'));
      const second = await notifications.upsert({ ...base, ownerId: owner, title: 'Second', dedupeKey: 'k' }, new Date('2026-01-02T00:00:00Z'));
      expect(second.id).toBe(first.id);
      expect(await notifications.list(owner, 10)).toHaveLength(1);
      expect((await notifications.list(owner, 10))[0]?.title).toBe('Second');

      // Once read, the next event is a new notification.
      await notifications.markRead(owner, [first.id]);
      const third = await notifications.upsert({ ...base, ownerId: owner, title: 'Third', dedupeKey: 'k' }, new Date('2026-01-03T00:00:00Z'));
      expect(third.id).not.toBe(first.id);
      expect(await notifications.unreadCount(owner)).toBe(1);
      expect((await notifications.list(owner, 10)).map((n) => n.title)).toEqual(['Third', 'Second']);
    });

    it('does not dedupe without a key, ignores malformed ids and only touches the owner’s rows', async () => {
      const owner = (await users.createGuest()).id;
      const intruder = (await users.createGuest()).id;
      const a = await notifications.upsert({ ...base, ownerId: owner, title: 'a', dedupeKey: null }, new Date());
      await notifications.upsert({ ...base, ownerId: owner, title: 'b', dedupeKey: null }, new Date());
      expect(await notifications.unreadCount(owner)).toBe(2);
      await notifications.markRead(owner, ['not-a-uuid']);
      await notifications.markRead(intruder, 'all');
      expect(await notifications.unreadCount(owner)).toBe(2);
      expect(await notifications.deleteOwned(intruder, a.id)).toBe(false);
      expect(await notifications.deleteOwned(owner, a.id)).toBe(true);
      await notifications.markRead(owner, 'all');
      expect(await notifications.unreadCount(owner)).toBe(0);
    });

    it('purges old notifications', async () => {
      const owner = (await users.createGuest()).id;
      await notifications.upsert({ ...base, ownerId: owner, title: 'old', dedupeKey: null }, new Date('2020-01-01T00:00:00Z'));
      await notifications.upsert({ ...base, ownerId: owner, title: 'new', dedupeKey: null }, new Date());
      expect(await notifications.deleteOlderThan(new Date('2021-01-01T00:00:00Z'))).toBeGreaterThanOrEqual(1);
      expect((await notifications.list(owner, 10)).map((n) => n.title)).toEqual(['new']);
    });
  });

  describe('schedules', () => {
    it('runs a periodic job on one instance at a time and only when due', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      // First ever claim wins; a concurrent one does not.
      const [first, second] = await Promise.all([schedules.claim('cleanup', 'a', t0, 60_000, 30_000), schedules.claim('cleanup', 'b', t0, 60_000, 30_000)]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const winner = first ? 'a' : 'b';
      // Not due yet (next run in 60 s), lease still held.
      expect(await schedules.claim('cleanup', 'c', new Date(t0.getTime() + 10_000), 60_000, 30_000)).toBe(false);
      await schedules.release('cleanup', winner, { ok: true });
      // Released but still not due.
      expect(await schedules.claim('cleanup', 'c', new Date(t0.getTime() + 10_000), 60_000, 30_000)).toBe(false);
      // Due again.
      expect(await schedules.claim('cleanup', 'c', new Date(t0.getTime() + 61_000), 60_000, 30_000)).toBe(true);
    });
  });
});

/** The 0001 → 0002 upgrade must keep every existing device signed in. */
describe.skipIf(!TEST_DATABASE_URL)('migration 0002 on a database that already has data', () => {
  it('copies existing tokens into sessions and keeps users and their sources', async () => {
    const legacy = await createTestDatabase({ migrate: false });
    try {
      const { db } = legacy.database;
      const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
      expect((await migrator.migrateTo('0001-core')).error).toBeUndefined();

      await sql`INSERT INTO users (id, token_hash, created_at, last_seen_at) VALUES ('0192f7d0-0000-7000-8000-000000000001', 'hash-of-existing-token', '2026-01-01', '2026-02-01')`.execute(db);
      await sql`INSERT INTO sources (id, owner_id, name, type, origin, sync_status) VALUES ('0192f7d0-0000-7000-8000-0000000000aa', '0192f7d0-0000-7000-8000-000000000001', 'Mine', 'm3u_url', '{"kind":"url","host":"x"}', 'idle')`.execute(db);

      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      const sessions = new PgSessionRepository(db);
      const found = await sessions.findByTokenHash('hash-of-existing-token');
      expect(found?.user).toMatchObject({ id: '0192f7d0-0000-7000-8000-000000000001', email: null, role: 'user' });
      expect(found?.session.expiresAt).toBeNull(); // guests never expire
      expect(found?.session.lastSeenAt).toEqual(new Date('2026-02-01'));
      expect((await new PgSourceRepository(db).listByOwner('0192f7d0-0000-7000-8000-000000000001')).map((s) => s.name)).toEqual(['Mine']);
    } finally {
      await legacy.close();
    }
  });
});
