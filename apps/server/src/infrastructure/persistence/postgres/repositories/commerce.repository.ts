import { sql, type Kysely, type Selectable } from 'kysely';

import type {
  CheckoutRecord,
  CommerceRepository,
  DeviceRecord,
  EntitlementRecord,
  InvoiceRecord,
  PackageRecord,
  PaymentEventRecord,
  PlaybackSessionRecord,
  SubscriptionRecord,
} from '../../../../application/ports/commerce.js';
import type { DeviceClass } from '../../../../domain/operator/catalog.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import { json, type Database } from '../schema.js';
import { PgOutboxRepository } from './admin.repository.js';

type Row<T extends keyof Database> = Selectable<Database[T]>;

const LIVE = ['canceled', 'expired'] as const;

function toPackage(row: Row<'packages'>): PackageRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceMinor: row.price_minor,
    currency: row.currency,
    billingPeriod: row.billing_period,
    trialDays: row.trial_days,
    maxDevices: row.max_devices,
    maxStreams: row.max_streams,
    businessModel: row.business_model,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toSubscription(row: Row<'subscriptions'>): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    endedAt: row.ended_at,
    processor: row.processor,
    processorRef: row.processor_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEntitlement(row: Row<'entitlements'>): EntitlementRecord {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    kind: row.kind,
    subscriptionId: row.subscription_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    revokedAt: row.revoked_at,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toDevice(row: Row<'devices'>): DeviceRecord {
  return { id: row.id, userId: row.user_id, name: row.name, platform: row.platform, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at };
}

function toSession(row: Row<'playback_sessions'>): PlaybackSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    deviceId: row.device_id,
    channelId: row.channel_id,
    access: row.access,
    packageId: row.package_id,
    country: row.country,
    providerId: row.provider_id,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    archive: row.archive_start && row.archive_end ? { start: row.archive_start, end: row.archive_end } : null,
  };
}

function toCheckout(row: Row<'checkouts'>): CheckoutRecord {
  return {
    id: row.id,
    userId: row.user_id,
    packageId: row.package_id,
    processor: row.processor,
    processorRef: row.processor_ref,
    withTrial: row.with_trial,
    status: row.status,
    subscriptionId: row.subscription_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toInvoice(row: Row<'invoices'>): InvoiceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    processor: row.processor,
    processorRef: row.processor_ref,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
  };
}

/** Commerce state in PostgreSQL; bound to the pool or (inside `transaction`) to one transaction. */
export class PgCommerceRepository implements CommerceRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly inTransaction = false,
  ) {}

  newId(): string {
    return newEntityId();
  }

  transaction<T>(work: (tx: CommerceRepository) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this);
    return this.db.transaction().execute((trx) => work(new PgCommerceRepository(trx, true)));
  }

  // --- packages -----------------------------------------------------------------------------------

  async listPackages(status?: PackageRecord['status']): Promise<(PackageRecord & { channels: number })[]> {
    let query = this.db
      .selectFrom('packages as p')
      .selectAll('p')
      .select((eb) => eb.selectFrom('package_channels as pc').whereRef('pc.package_id', '=', 'p.id').select((inner) => inner.fn.countAll<string>().as('n')).as('channels'));
    if (status) query = query.where('p.status', '=', status);
    const rows = await query.orderBy('p.price_minor').orderBy('p.name').execute();
    return rows.map((row) => ({ ...toPackage(row), channels: Number(row.channels ?? 0) }));
  }

  async findPackage(idOrSlug: string): Promise<PackageRecord | null> {
    const row = await this.db
      .selectFrom('packages')
      .selectAll()
      .where((eb) => (isEntityId(idOrSlug) ? eb('id', '=', idOrSlug) : eb('slug', '=', idOrSlug)))
      .executeTakeFirst();
    return row ? toPackage(row) : null;
  }

  async findPackages(ids: string[]): Promise<PackageRecord[]> {
    if (ids.length === 0) return [];
    return (await this.db.selectFrom('packages').selectAll().where('id', 'in', ids).execute()).map(toPackage);
  }

  async createPackage(input: Omit<PackageRecord, 'createdAt'>): Promise<PackageRecord> {
    const row = await this.db
      .insertInto('packages')
      .values({
        id: input.id,
        slug: input.slug,
        name: input.name,
        description: input.description,
        price_minor: input.priceMinor,
        currency: input.currency,
        billing_period: input.billingPeriod,
        trial_days: input.trialDays,
        max_devices: input.maxDevices,
        max_streams: input.maxStreams,
        business_model: input.businessModel,
        status: input.status,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPackage(row);
  }

  async updatePackage(id: string, patch: Partial<Omit<PackageRecord, 'id' | 'createdAt'>>): Promise<PackageRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('packages')
      .set({
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.priceMinor !== undefined ? { price_minor: patch.priceMinor } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.billingPeriod !== undefined ? { billing_period: patch.billingPeriod } : {}),
        ...(patch.trialDays !== undefined ? { trial_days: patch.trialDays } : {}),
        ...(patch.maxDevices !== undefined ? { max_devices: patch.maxDevices } : {}),
        ...(patch.maxStreams !== undefined ? { max_streams: patch.maxStreams } : {}),
        ...(patch.businessModel !== undefined ? { business_model: patch.businessModel } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toPackage(row) : null;
  }

  async packageChannels(packageId: string): Promise<string[]> {
    return (await this.db.selectFrom('package_channels').select('channel_id').where('package_id', '=', packageId).execute()).map((row) => row.channel_id);
  }

  async setPackageChannels(packageId: string, channelIds: string[]): Promise<void> {
    await this.db.deleteFrom('package_channels').where('package_id', '=', packageId).execute();
    if (channelIds.length > 0) await this.db.insertInto('package_channels').values([...new Set(channelIds)].map((channelId) => ({ package_id: packageId, channel_id: channelId }))).execute();
  }

  async packagesOfChannels(channelIds: string[]): Promise<Map<string, PackageRecord[]>> {
    const result = new Map<string, PackageRecord[]>();
    if (channelIds.length === 0) return result;
    // Every status: a retired package still serves the subscribers and comp holders who have it.
    const rows = await this.db.selectFrom('package_channels as pc').innerJoin('packages as p', 'p.id', 'pc.package_id').selectAll('p').select('pc.channel_id').where('pc.channel_id', 'in', channelIds).execute();
    for (const row of rows) result.set(row.channel_id, [...(result.get(row.channel_id) ?? []), toPackage(row)]);
    return result;
  }

  // --- subscriptions ------------------------------------------------------------------------------

  async liveSubscription(userId: string, options: { lock?: boolean } = {}): Promise<SubscriptionRecord | null> {
    const query = this.db.selectFrom('subscriptions').selectAll().where('user_id', '=', userId).where('status', 'not in', LIVE);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toSubscription(row) : null;
  }

  async findSubscription(id: string, options: { lock?: boolean } = {}): Promise<SubscriptionRecord | null> {
    if (!isEntityId(id)) return null;
    const query = this.db.selectFrom('subscriptions').selectAll().where('id', '=', id);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toSubscription(row) : null;
  }

  async findSubscriptionByRef(processor: string, ref: string, options: { lock?: boolean } = {}): Promise<SubscriptionRecord | null> {
    const query = this.db.selectFrom('subscriptions').selectAll().where('processor', '=', processor).where('processor_ref', '=', ref);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toSubscription(row) : null;
  }

  async createSubscription(record: Omit<SubscriptionRecord, 'createdAt' | 'updatedAt'>, now: Date): Promise<SubscriptionRecord> {
    const row = await this.db
      .insertInto('subscriptions')
      .values({
        id: record.id,
        user_id: record.userId,
        package_id: record.packageId,
        status: record.status,
        trial_ends_at: record.trialEndsAt,
        current_period_start: record.currentPeriodStart,
        current_period_end: record.currentPeriodEnd,
        cancel_at_period_end: record.cancelAtPeriodEnd,
        ended_at: record.endedAt,
        processor: record.processor,
        processor_ref: record.processorRef,
        reconciled_at: now,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSubscription(row);
  }

  async saveSubscription(record: SubscriptionRecord, now: Date): Promise<void> {
    await this.db
      .updateTable('subscriptions')
      .set({
        status: record.status,
        trial_ends_at: record.trialEndsAt,
        current_period_start: record.currentPeriodStart,
        current_period_end: record.currentPeriodEnd,
        cancel_at_period_end: record.cancelAtPeriodEnd,
        ended_at: record.endedAt,
        updated_at: now,
      })
      .where('id', '=', record.id)
      .execute();
  }

  async dueSubscriptions(now: Date, limit: number): Promise<string[]> {
    const rows = await sql<{ id: string }>`
      SELECT id FROM subscriptions
      WHERE status NOT IN ('canceled', 'expired') AND coalesce(current_period_end, trial_ends_at) <= ${now}
      ORDER BY coalesce(current_period_end, trial_ends_at)
      LIMIT ${limit}`.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  async subscriptionsToReconcile(before: Date, limit: number): Promise<SubscriptionRecord[]> {
    const rows = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('status', 'not in', LIVE)
      .where((eb) => eb.or([eb('reconciled_at', 'is', null), eb('reconciled_at', '<', before)]))
      .orderBy('reconciled_at')
      .limit(limit)
      .execute();
    return rows.map(toSubscription);
  }

  async markReconciled(id: string, now: Date): Promise<void> {
    await this.db.updateTable('subscriptions').set({ reconciled_at: now }).where('id', '=', id).execute();
  }

  async hadTrial(userId: string): Promise<boolean> {
    const row = await this.db.selectFrom('subscriptions').select('id').where('user_id', '=', userId).where('trial_ends_at', 'is not', null).executeTakeFirst();
    return row !== undefined;
  }

  async subscriptionsOf(userId: string): Promise<SubscriptionRecord[]> {
    return (await this.db.selectFrom('subscriptions').selectAll().where('user_id', '=', userId).orderBy('created_at', 'desc').execute()).map(toSubscription);
  }

  // --- entitlements -------------------------------------------------------------------------------

  async entitlementsOf(userId: string): Promise<EntitlementRecord[]> {
    return (await this.db.selectFrom('entitlements').selectAll().where('user_id', '=', userId).orderBy('created_at', 'desc').execute()).map(toEntitlement);
  }

  async syncSubscriptionEntitlement(input: { subscriptionId: string; userId: string; packageId: string; startsAt: Date; endsAt: Date | null; revoked: boolean; now: Date }): Promise<void> {
    await this.db
      .insertInto('entitlements')
      .values({
        id: newEntityId(),
        user_id: input.userId,
        package_id: input.packageId,
        kind: 'subscription',
        subscription_id: input.subscriptionId,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        revoked_at: input.revoked ? input.now : null,
        note: null,
        created_by: null,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((conflict) =>
        conflict.column('subscription_id').doUpdateSet({
          package_id: input.packageId,
          ends_at: input.endsAt,
          // once revoked, a subscription's entitlement stays revoked (a new purchase is a new one)
          revoked_at: input.revoked ? sql<Date>`coalesce(entitlements.revoked_at, ${input.now})` : sql<null>`entitlements.revoked_at`,
          updated_at: input.now,
        }),
      )
      .execute();
  }

  async createCompEntitlement(input: { id: string; userId: string; packageId: string; startsAt: Date; endsAt: Date | null; note: string | null; createdBy: string; now: Date }): Promise<EntitlementRecord> {
    const row = await this.db
      .insertInto('entitlements')
      .values({
        id: input.id,
        user_id: input.userId,
        package_id: input.packageId,
        kind: 'comp',
        subscription_id: null,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        revoked_at: null,
        note: input.note,
        created_by: input.createdBy,
        created_at: input.now,
        updated_at: input.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntitlement(row);
  }

  async revokeEntitlement(id: string, now: Date): Promise<EntitlementRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.updateTable('entitlements').set({ revoked_at: now, updated_at: now }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
    return row ? toEntitlement(row) : null;
  }

  // --- devices ------------------------------------------------------------------------------------

  async devicesOf(userId: string): Promise<DeviceRecord[]> {
    return (await this.db.selectFrom('devices').selectAll().where('user_id', '=', userId).where('revoked_at', 'is', null).orderBy('last_seen_at', 'desc').execute()).map(toDevice);
  }

  async findDevice(id: string): Promise<DeviceRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toDevice(row) : null;
  }

  async findDeviceByKey(userId: string, keyHash: string): Promise<DeviceRecord | null> {
    const row = await this.db.selectFrom('devices').selectAll().where('user_id', '=', userId).where('key_hash', '=', keyHash).where('revoked_at', 'is', null).executeTakeFirst();
    return row ? toDevice(row) : null;
  }

  async lockAccount(userId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`ziptv:account:${userId}`}))`.execute(this.db);
  }

  async createDevice(input: { id: string; userId: string; keyHash: string; name: string; platform: DeviceClass; now: Date }): Promise<DeviceRecord> {
    const row = await this.db
      .insertInto('devices')
      .values({ id: input.id, user_id: input.userId, key_hash: input.keyHash, name: input.name, platform: input.platform, created_at: input.now, last_seen_at: input.now, revoked_at: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDevice(row);
  }

  async touchDevice(id: string, now: Date): Promise<void> {
    await this.db.updateTable('devices').set({ last_seen_at: now }).where('id', '=', id).execute();
  }

  async revokeDevice(id: string, now: Date): Promise<boolean> {
    const result = await this.db.updateTable('devices').set({ revoked_at: now }).where('id', '=', id).where('revoked_at', 'is', null).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  // --- playback sessions --------------------------------------------------------------------------

  async createPlaybackSession(record: Omit<PlaybackSessionRecord, 'endedAt' | 'endReason'>): Promise<void> {
    await this.db
      .insertInto('playback_sessions')
      .values({
        id: record.id,
        user_id: record.userId,
        profile_id: record.profileId,
        device_id: record.deviceId,
        channel_id: record.channelId,
        access: record.access,
        package_id: record.packageId,
        country: record.country,
        provider_id: record.providerId,
        started_at: record.startedAt,
        last_heartbeat_at: record.lastHeartbeatAt,
        expires_at: record.expiresAt,
        ended_at: null,
        end_reason: null,
        archive_start: record.archive?.start ?? null,
        archive_end: record.archive?.end ?? null,
      })
      .execute();
  }

  async findPlaybackSession(id: string): Promise<PlaybackSessionRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db.selectFrom('playback_sessions').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toSession(row) : null;
  }

  async heartbeatPlaybackSession(id: string, now: Date, expiresAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('playback_sessions')
      .set({ last_heartbeat_at: now, expires_at: expiresAt })
      .where('id', '=', id)
      .where('ended_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async endPlaybackSession(id: string, now: Date, reason: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    const result = await this.db.updateTable('playback_sessions').set({ ended_at: now, end_reason: reason }).where('id', '=', id).where('ended_at', 'is', null).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async liveSessionsOf(userId: string, now: Date): Promise<(PlaybackSessionRecord & { deviceName: string })[]> {
    const rows = await this.db
      .selectFrom('playback_sessions as s')
      .innerJoin('devices as d', 'd.id', 's.device_id')
      .selectAll('s')
      .select('d.name as device_name')
      .where('s.user_id', '=', userId)
      .where('s.ended_at', 'is', null)
      .where('s.expires_at', '>', now)
      .orderBy('s.started_at')
      .execute();
    return rows.map((row) => ({ ...toSession(row), deviceName: row.device_name }));
  }

  async liveSessionsOnChannel(channelId: string, now: Date): Promise<PlaybackSessionRecord[]> {
    const rows = await this.db.selectFrom('playback_sessions').selectAll().where('channel_id', '=', channelId).where('ended_at', 'is', null).where('expires_at', '>', now).execute();
    return rows.map(toSession);
  }

  async endSessionsWhere(filter: { deviceId?: string; userId?: string }, now: Date, reason: string): Promise<string[]> {
    if (!filter.deviceId && !filter.userId) return [];
    let query = this.db.updateTable('playback_sessions').set({ ended_at: now, end_reason: reason }).where('ended_at', 'is', null);
    if (filter.deviceId) query = query.where('device_id', '=', filter.deviceId);
    if (filter.userId) query = query.where('user_id', '=', filter.userId);
    return (await query.returning('id').execute()).map((row) => row.id);
  }

  async endExpiredSessions(now: Date): Promise<{ id: string; userId: string }[]> {
    const rows = await this.db.updateTable('playback_sessions').set({ ended_at: sql`expires_at`, end_reason: 'timeout' }).where('ended_at', 'is', null).where('expires_at', '<=', now).returning(['id', 'user_id']).execute();
    return rows.map((row) => ({ id: row.id, userId: row.user_id }));
  }

  async servingProvider(channelId: string): Promise<string | null> {
    if (!isEntityId(channelId)) return null;
    const row = await sql<{ provider_id: string }>`
      SELECT f.provider_id FROM channel_feeds f
      JOIN providers p ON p.id = f.provider_id
      JOIN provider_streams s ON s.id = f.provider_stream_id
      LEFT JOIN channel_failover cf ON cf.channel_id = f.channel_id
      WHERE f.channel_id = ${channelId} AND f.status = 'active' AND p.status = 'active' AND s.status = 'matched'
      ORDER BY (f.id = cf.active_feed_id) DESC NULLS LAST, f.priority
      LIMIT 1`.execute(this.db);
    return row.rows[0]?.provider_id ?? null;
  }

  async pruneCommerce(before: { endedSessions: Date; expiredCheckouts: Date }): Promise<{ sessions: number; checkouts: number }> {
    const sessions = await this.db.deleteFrom('playback_sessions').where('ended_at', '<', before.endedSessions).executeTakeFirst();
    const checkouts = await this.db.deleteFrom('checkouts').where('status', '=', 'expired').where('created_at', '<', before.expiredCheckouts).executeTakeFirst();
    return { sessions: Number(sessions.numDeletedRows), checkouts: Number(checkouts.numDeletedRows) };
  }

  // --- checkouts, invoices, payment events --------------------------------------------------------

  async createCheckout(record: Omit<CheckoutRecord, 'createdAt' | 'completedAt' | 'status' | 'subscriptionId'>, now: Date): Promise<CheckoutRecord> {
    const row = await this.db
      .insertInto('checkouts')
      .values({ id: record.id, user_id: record.userId, package_id: record.packageId, processor: record.processor, processor_ref: record.processorRef, with_trial: record.withTrial, subscription_id: null, created_at: now, completed_at: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCheckout(row);
  }

  async setCheckoutRef(id: string, ref: string): Promise<void> {
    await this.db.updateTable('checkouts').set({ processor_ref: ref }).where('id', '=', id).execute();
  }

  async findCheckout(id: string, options: { lock?: boolean } = {}): Promise<CheckoutRecord | null> {
    if (!isEntityId(id)) return null;
    const query = this.db.selectFrom('checkouts').selectAll().where('id', '=', id);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toCheckout(row) : null;
  }

  async findCheckoutByRef(processor: string, ref: string, options: { lock?: boolean } = {}): Promise<CheckoutRecord | null> {
    const query = this.db.selectFrom('checkouts').selectAll().where('processor', '=', processor).where('processor_ref', '=', ref);
    const row = await (options.lock ? query.forUpdate() : query).executeTakeFirst();
    return row ? toCheckout(row) : null;
  }

  async completeCheckout(id: string, subscriptionId: string, now: Date): Promise<void> {
    await this.db.updateTable('checkouts').set({ status: 'completed', subscription_id: subscriptionId, completed_at: now }).where('id', '=', id).execute();
  }

  async openCheckouts(createdBefore: Date, limit: number): Promise<CheckoutRecord[]> {
    const rows = await this.db.selectFrom('checkouts').selectAll().where('status', '=', 'open').where('created_at', '<', createdBefore).orderBy('created_at').limit(limit).execute();
    return rows.map(toCheckout);
  }

  async expireCheckout(id: string): Promise<void> {
    await this.db.updateTable('checkouts').set({ status: 'expired' }).where('id', '=', id).where('status', '=', 'open').execute();
  }

  async recordInvoice(record: InvoiceRecord): Promise<boolean> {
    const result = await this.db
      .insertInto('invoices')
      .values({
        id: record.id,
        user_id: record.userId,
        subscription_id: record.subscriptionId,
        processor: record.processor,
        processor_ref: record.processorRef,
        amount_minor: record.amountMinor,
        currency: record.currency,
        status: record.status,
        period_start: record.periodStart,
        period_end: record.periodEnd,
        paid_at: record.paidAt,
        refunded_at: record.refundedAt,
      })
      .onConflict((conflict) => conflict.columns(['processor', 'processor_ref']).doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
  }

  async refundInvoice(processor: string, ref: string, now: Date): Promise<boolean> {
    const result = await this.db.updateTable('invoices').set({ status: 'refunded', refunded_at: now }).where('processor', '=', processor).where('processor_ref', '=', ref).where('status', '=', 'paid').executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async invoicesOf(userId: string): Promise<InvoiceRecord[]> {
    return (await this.db.selectFrom('invoices').selectAll().where('user_id', '=', userId).orderBy('paid_at', 'desc').limit(100).execute()).map(toInvoice);
  }

  async recordPaymentEvent(input: { id: string; processor: string; eventId: string; type: string; payload: unknown; now: Date }): Promise<{ duplicate: boolean }> {
    const result = await this.db
      .insertInto('payment_events')
      .values({ id: input.id, processor: input.processor, event_id: input.eventId, type: input.type, payload: json(input.payload), received_at: input.now, processed_at: null, outcome: null })
      .onConflict((conflict) => conflict.columns(['processor', 'event_id']).doNothing())
      .executeTakeFirst();
    return { duplicate: Number(result.numInsertedOrUpdatedRows ?? 0n) === 0 };
  }

  async markPaymentEvent(processor: string, eventId: string, outcome: string, now: Date): Promise<void> {
    await this.db.updateTable('payment_events').set({ processed_at: now, outcome: outcome.slice(0, 300) }).where('processor', '=', processor).where('event_id', '=', eventId).execute();
  }

  async paymentEvents(limit: number): Promise<PaymentEventRecord[]> {
    const rows = await this.db.selectFrom('payment_events').select(['id', 'processor', 'event_id', 'type', 'received_at', 'processed_at', 'outcome']).orderBy('received_at', 'desc').limit(limit).execute();
    return rows.map((row) => ({ id: row.id, processor: row.processor, eventId: row.event_id, type: row.type, receivedAt: row.received_at, processedAt: row.processed_at, outcome: row.outcome }));
  }

  // --- accounts -----------------------------------------------------------------------------------

  async account(userId: string): Promise<{ id: string; email: string | null; blockedAt: Date | null; blockedReason: string | null } | null> {
    if (!isEntityId(userId)) return null;
    const row = await this.db.selectFrom('users').select(['id', 'email', 'blocked_at', 'blocked_reason']).where('id', '=', userId).executeTakeFirst();
    return row ? { id: row.id, email: row.email, blockedAt: row.blocked_at, blockedReason: row.blocked_reason } : null;
  }

  async setBlocked(userId: string, blocked: boolean, reason: string | null, now: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('users')
      .set(blocked ? { blocked_at: now, blocked_reason: reason } : { blocked_at: null, blocked_reason: null })
      .where('id', '=', userId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async enqueue(topic: string, payload: Record<string, unknown>, now: Date): Promise<void> {
    await new PgOutboxRepository(this.db).enqueue({ id: newEntityId(), topic, payload, now });
  }
}
