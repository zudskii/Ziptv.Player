import { createHash, randomUUID } from 'node:crypto';

import type { ActivePlaybackDto, ConcurrencyLimitDetails, DeviceDto, PlaybackHeartbeatDto, PlaybackSessionDto, RegisterDeviceRequest, StartPlaybackSessionRequest } from '@ziptv/contracts';

import type { AccessDecision } from '../../domain/commerce/entitlement.js';
import { catchupGrants } from '../../domain/operator/rights.js';
import { AppError } from '../errors.js';
import { unrestrictedViewer, type Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, DeviceRecord, PlaybackSessionRecord } from '../ports/commerce.js';
import type { LeaseStore } from '../ports/lease-store.js';
import type { Logger } from '../ports/logger.js';
import type { OperatorService, ViewingContext } from '../operator/operator.service.js';
import type { PlaybackService } from '../playback/playback.service.js';
import type { EntitlementService } from './entitlement.service.js';

export const HEARTBEAT_INTERVAL_SECONDS = 30;
/**
 * A viewing whose heartbeats stop frees its stream slot after this long. Browsers throttle timers
 * of hidden tabs to about once a minute, so this leaves room for one late beat in a background tab.
 */
export const LEASE_TTL_MS = 120_000;

const DENIAL_MESSAGES: Record<string, string> = {
  account_blocked: 'This account is blocked. Contact support.',
  territory: 'This channel is not available in your country.',
  device: 'This channel is not available on this device.',
  not_licensed: 'This channel is not available right now.',
  no_subscription: 'Subscribe to a package to watch this channel.',
  not_in_package: 'This channel is not in your package.',
  device_revoked: 'This device was removed from your account.',
};

const streamsKey = (userId: string) => `streams:${userId}`;

/**
 * Playback authorization (ZP-ENT-08/09, Blueprint §8). A viewing of an operator channel is a
 * server-side session:
 *   1 identity (account not blocked) and a registered, non-revoked device of this account
 *   2 channel + rights for the server-determined country and the device's class + entitlement
 *   3 an atomic concurrency lease (max streams of the viewer's packages)
 *   4–5 failover-ordered licensed feeds, delivered through the proxy with links bound to the session
 *   6 `{ playbackSessionId, heartbeatIntervalSeconds, expiresAt, policy, plan }`
 *   7 heartbeats re-check everything and renew the lease; stop / timeout release it and kill the links
 */
export class PlaybackAuthorizationService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      entitlements: EntitlementService;
      operator: Pick<OperatorService, 'accessContext' | 'assertViewable'>;
      playback: Pick<PlaybackService, 'operatorPlan'>;
      leases: LeaseStore;
      clock: Clock;
      logger: Logger;
      /** A playback session ended: its stream links must stop now (grant cache). */
      onEnded?: (playbackSessionId: string) => void;
    },
  ) {}

  // --- devices -------------------------------------------------------------------------------------

  async registerDevice(viewer: Viewer, input: RegisterDeviceRequest): Promise<DeviceDto> {
    const keyHash = createHash('sha256').update(input.key).digest('hex');
    const now = this.deps.clock.now();
    // Read before the transaction: inside it, a second pooled connection per registration could
    // exhaust the pool under a burst (every holder of the lock waiting for a connection).
    const { limits } = await this.deps.entitlements.viewerAccess(viewer);
    const device = await this.deps.commerce.transaction(async (tx) => {
      // Serialised per account: two tabs registering at once cannot both take the last slot.
      await tx.lockAccount(viewer.userId);
      const existing = await tx.findDeviceByKey(viewer.userId, keyHash);
      if (existing) {
        await tx.touchDevice(existing.id, now);
        return existing;
      }
      const devices = await tx.devicesOf(viewer.userId);
      if (devices.length >= limits.maxDevices) {
        throw new AppError('DEVICE_LIMIT', 409, `Your plan allows ${limits.maxDevices} devices. Remove one to add this device.`, { limit: limits.maxDevices, devices: devices.map((item) => toDeviceDto(item, null)) });
      }
      return tx.createDevice({ id: tx.newId(), userId: viewer.userId, keyHash, name: input.name.trim(), platform: input.platform, now });
    });
    return toDeviceDto(device, device.id);
  }

  async devices(viewer: Viewer, currentDeviceId: string | null): Promise<DeviceDto[]> {
    return (await this.deps.commerce.devicesOf(viewer.userId)).map((device) => toDeviceDto(device, currentDeviceId));
  }

  /** Removes a device: its viewings end at once (links die at the proxy). */
  async revokeDevice(viewer: Pick<Viewer, 'userId'>, deviceId: string): Promise<void> {
    const device = await this.deps.commerce.findDevice(deviceId);
    if (!device || device.userId !== viewer.userId || device.revokedAt) throw AppError.notFound('Device');
    const now = this.deps.clock.now();
    await this.deps.commerce.revokeDevice(device.id, now);
    for (const id of await this.deps.commerce.endSessionsWhere({ deviceId: device.id }, now, 'device_revoked')) await this.released(viewer.userId, id);
  }

  // --- playback sessions ---------------------------------------------------------------------------

  async start(viewer: Viewer, input: StartPlaybackSessionRequest, context: ViewingContext): Promise<PlaybackSessionDto> {
    const now = this.deps.clock.now();
    // The previous viewing of this player (zap, reconnect) frees its slot first.
    if (input.replaces) {
      const previous = await this.deps.commerce.findPlaybackSession(input.replaces);
      if (previous && previous.userId === viewer.userId) await this.end(viewer, previous.id, 'replaced');
    }
    // History continuity is checked by the watch observer (same profile, same content, recent).
    const continueSession = input.continueSession;

    // 1. identity + device
    const device = await this.requireDevice(viewer, input.deviceId);
    const where: ViewingContext = { country: context.country, device: device.platform };

    // 2. channel, rights (catch-up rights for an archive viewing), entitlement
    const archive = input.archive ? { start: new Date(input.archive.start), end: new Date(input.archive.end) } : null;
    // Parental locks are checked when a viewing starts (the unlock token is short-lived; heartbeats do not need it).
    await this.deps.operator.assertViewable(viewer, input.channelId);
    const { channel, grants } = await this.deps.operator.accessContext(viewer, input.channelId);
    const access = await this.deps.entitlements.viewerAccess(viewer);
    const usable = archive ? catchupGrants(grants, { country: where.country, device: where.device, at: now }, archive.start) : grants;
    if (archive && usable.length === 0) throw new AppError('NOT_ENTITLED', 403, 'Catch-up is not licensed for this programme.', { reason: 'catchup_not_licensed' });
    const decision = await this.deps.entitlements.decide(access, channel.id, usable, where);
    if (!decision.allowed) throw denied(decision.reason);

    // 3. concurrency lease (atomic across instances)
    const id = randomUUID();
    const lease = await this.deps.leases.acquire(streamsKey(viewer.userId), id, { limit: access.limits.maxStreams, ttlMs: LEASE_TTL_MS });
    if (!lease.acquired) {
      const playing = await this.playing(viewer.userId);
      const details: ConcurrencyLimitDetails = { limit: access.limits.maxStreams, playing };
      throw new AppError('CONCURRENCY_LIMIT', 409, `Your plan allows ${access.limits.maxStreams} simultaneous stream${access.limits.maxStreams === 1 ? '' : 's'}. Stop one to watch here.`, details);
    }

    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    const providerId = decision.via.kind === 'package' ? await this.deps.commerce.servingProvider(channel.id).catch(() => null) : null;
    try {
      await this.deps.commerce.createPlaybackSession({
        id,
        userId: viewer.userId,
        profileId: viewer.profileId,
        deviceId: device.id,
        channelId: channel.id,
        access: decision.via.kind,
        packageId: decision.via.kind === 'package' ? decision.via.packageId : null,
        country: where.country,
        providerId,
        startedAt: now,
        lastHeartbeatAt: now,
        expiresAt,
        archive,
      });
    } catch (error) {
      // No session row = nobody would ever release this slot.
      await this.deps.leases.release(streamsKey(viewer.userId), id);
      throw error;
    }
    await this.deps.commerce.touchDevice(device.id, now);

    // 4–5. feeds and links bound to this session
    try {
      const plan = await this.deps.playback.operatorPlan(
        viewer,
        { channelId: channel.id, secureContext: input.secureContext, ...(continueSession ? { continueSession } : {}), ...(archive ? { archive } : {}) },
        where,
        { kind: 'playback', id },
      );
      this.deps.logger.info({ userId: viewer.userId, playbackSessionId: id, channelId: channel.id, deviceId: device.id, access: decision.via.kind, country: where.country }, 'Playback session started');
      return {
        playbackSessionId: id,
        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
        expiresAt: expiresAt.toISOString(),
        policy: { access: decision.via.kind, maxStreams: access.limits.maxStreams, activeStreams: lease.holders },
        plan,
      };
    } catch (error) {
      await this.end(viewer, id, 'no_plan');
      throw error;
    }
  }

  /** Re-authorizes the viewing (entitlement, rights in the current country, device) and renews it. */
  async heartbeat(viewer: Viewer, id: string, context: ViewingContext): Promise<PlaybackHeartbeatDto> {
    const session = await this.requireSession(viewer, id);
    const now = this.deps.clock.now();
    if (session.endedAt || session.expiresAt <= now) throw new AppError('NOT_FOUND', 404, 'This viewing has ended. Start it again.', { reason: session.endReason ?? 'timeout' });

    const verdict = await this.reauthorize(viewer, session, context);
    if (!verdict.allowed) {
      await this.end(viewer, id, verdict.reason);
      throw denied(verdict.reason);
    }
    const access = await this.deps.entitlements.viewerAccess(viewer);
    if (!(await this.deps.leases.renew(streamsKey(viewer.userId), id, LEASE_TTL_MS))) {
      // The lease lapsed (long network gap): take it again only if a slot is free.
      const lease = await this.deps.leases.acquire(streamsKey(viewer.userId), id, { limit: access.limits.maxStreams, ttlMs: LEASE_TTL_MS });
      if (!lease.acquired) {
        await this.end(viewer, id, 'concurrency');
        throw new AppError('CONCURRENCY_LIMIT', 409, 'Another device took this stream slot.', { limit: access.limits.maxStreams, playing: await this.playing(viewer.userId) } satisfies ConcurrencyLimitDetails);
      }
    }
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    if (!(await this.deps.commerce.heartbeatPlaybackSession(id, now, expiresAt))) {
      // Ended meanwhile (stopped elsewhere, revalidated): the lease just renewed/acquired must go too.
      await this.released(viewer.userId, id);
      throw new AppError('NOT_FOUND', 404, 'This viewing has ended. Start it again.', { reason: 'ended' });
    }
    return { expiresAt: expiresAt.toISOString() };
  }

  /** Stop (this device, or another of the account's — "stop one to watch here"). */
  async stop(viewer: Viewer, id: string): Promise<void> {
    await this.requireSession(viewer, id);
    await this.end(viewer, id, 'stopped');
  }

  async playing(userId: string): Promise<ActivePlaybackDto[]> {
    return (await this.deps.commerce.liveSessionsOf(userId, this.deps.clock.now())).map((session) => ({
      playbackSessionId: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      channelId: session.channelId,
      startedAt: session.startedAt.toISOString(),
    }));
  }

  /** Housekeeping: viewings whose heartbeats stopped. */
  async expireStale(): Promise<number> {
    const ended = await this.deps.commerce.endExpiredSessions(this.deps.clock.now());
    // The lease usually lapsed by itself (same TTL); releasing it makes the slot free regardless.
    for (const session of ended) await this.released(session.userId, session.id);
    return ended.length;
  }

  /** Ends every viewing of an account (blocked by staff, entitlement revoked). */
  async endAllOf(userId: string, reason: string): Promise<number> {
    const ids = await this.deps.commerce.endSessionsWhere({ userId }, this.deps.clock.now(), reason);
    for (const id of ids) await this.released(userId, id);
    return ids.length;
  }

  /**
   * Access changed outside a heartbeat (refund, expiry, comp revoked, cancel now): re-checks the
   * account's live viewings at once and ends the ones that lost their entitlement, instead of
   * letting them run until the next heartbeat.
   */
  async revalidate(userId: string): Promise<number> {
    return this.revalidateSessions(await this.deps.commerce.liveSessionsOf(userId, this.deps.clock.now()));
  }

  /** A rights grant of the channel was revoked or narrowed: re-checks everyone watching it. */
  async revalidateChannel(channelId: string): Promise<number> {
    return this.revalidateSessions(await this.deps.commerce.liveSessionsOnChannel(channelId, this.deps.clock.now()));
  }

  private async revalidateSessions(sessions: PlaybackSessionRecord[]): Promise<number> {
    let ended = 0;
    for (const session of sessions) {
      const viewer = unrestrictedViewer(session.userId, session.profileId ?? session.userId);
      // The device class comes from the registered device inside reauthorize.
      const verdict = await this.reauthorize(viewer, session, { country: session.country, device: 'web' });
      if (verdict.allowed) continue;
      await this.end(viewer, session.id, verdict.reason);
      ended += 1;
    }
    return ended;
  }

  // ---------------------------------------------------------------------------------------------

  private async reauthorize(viewer: Viewer, session: PlaybackSessionRecord, context: ViewingContext): Promise<AccessDecision | { allowed: false; reason: 'device_revoked' }> {
    const device = await this.deps.commerce.findDevice(session.deviceId);
    if (!device || device.revokedAt) return { allowed: false, reason: 'device_revoked' };
    let grants;
    try {
      ({ grants } = await this.deps.operator.accessContext(viewer, session.channelId));
    } catch {
      return { allowed: false, reason: 'not_licensed' };
    }
    const access = await this.deps.entitlements.viewerAccess(viewer);
    const where = { country: context.country, device: device.platform };
    // A catch-up viewing keeps needing catch-up rights (revoked or narrowed → it ends too).
    const usable = session.archive ? catchupGrants(grants, { ...where, at: this.deps.clock.now() }, session.archive.start) : grants;
    if (session.archive && usable.length === 0) return { allowed: false, reason: 'not_licensed' };
    return this.deps.entitlements.decide(access, session.channelId, usable, where);
  }

  private async end(viewer: Pick<Viewer, 'userId'>, id: string, reason: string): Promise<void> {
    const ended = await this.deps.commerce.endPlaybackSession(id, this.deps.clock.now(), reason);
    // Released even when it had already ended: a lease left behind would hold a stream slot.
    await this.released(viewer.userId, id);
    if (ended) this.deps.logger.info({ userId: viewer.userId, playbackSessionId: id, reason }, 'Playback session ended');
  }

  private async released(userId: string, id: string): Promise<void> {
    await this.deps.leases.release(streamsKey(userId), id);
    this.deps.onEnded?.(id);
  }

  private async requireDevice(viewer: Viewer, deviceId: string): Promise<DeviceRecord> {
    const device = await this.deps.commerce.findDevice(deviceId);
    if (!device || device.userId !== viewer.userId || device.revokedAt) throw new AppError('DEVICE_REQUIRED', 403, 'Register this device to watch.', { reason: 'device_required' });
    return device;
  }

  private async requireSession(viewer: Viewer, id: string): Promise<PlaybackSessionRecord> {
    const session = await this.deps.commerce.findPlaybackSession(id);
    if (!session || session.userId !== viewer.userId) throw AppError.notFound('Playback session');
    return session;
  }
}

function denied(reason: string): AppError {
  return new AppError('NOT_ENTITLED', 403, DENIAL_MESSAGES[reason] ?? 'This channel is not available.', { reason });
}

function toDeviceDto(device: DeviceRecord, currentDeviceId: string | null): DeviceDto {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt.toISOString(),
    current: device.id === currentDeviceId,
  };
}
