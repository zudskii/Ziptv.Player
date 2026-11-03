import type {
  CategoryDto,
  ChangeRequestDto,
  CreateGrantRequest,
  CreateLineupRequest,
  CreateMasterChannelRequest,
  CreateProviderRequest,
  FeedDto,
  LineupDetailDto,
  LineupDto,
  MasterChannelDetailDto,
  MasterChannelDto,
  MasterChannelPageDto,
  MasterChannelStatsDto,
  ProviderCredentialInput,
  ProviderDto,
  ProviderHealthDto,
  ProviderStreamDto,
  ProviderStreamPageDto,
  ProviderStreamStatus,
  ReviewStreamRequest,
  RightsGrantDto,
  UpdateFeedRequest,
  UpdateLineupRequest,
  UpdateMasterChannelRequest,
  UpdateProviderRequest,
} from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { aliasKeys, isCountryCode, isLanguageCode, isTerritory, slugify, validateLineup } from '../../domain/operator/catalog.js';
import { playableFeeds } from '../../domain/operator/feeds.js';
import { normalizeChannelName } from '../../domain/shared/text.js';
import { actorOf, type AdminContext, type StaffPrincipal } from '../admin/principal.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork } from '../ports/admin.js';
import type { ConsoleQueries } from '../ports/console.js';
import type { ChangeHandler, ChangeRequestService } from '../admin/change-requests.service.js';
import type { Clock } from '../ports/clock.js';
import type { FeedRecord, LineupRecord, MasterChannelRecord, OperatorCatalogRepository, ProviderAdapters, ProviderContract, ProviderRecord, ProviderStreamRecord, StoredGrant } from '../ports/operator.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { JobKicker } from '../sources/hooks.js';
import type { ProviderConnections } from './provider-connections.js';
import { PROVIDER_SYNC_JOB, type ProviderSyncService } from './provider-sync.js';

const ENV_REF = /^env:ZIPTV_SECRET_[A-Z0-9_]{1,64}$/;
const HEALTH_TIMEOUT_MS = 20_000;

/**
 * Console use cases of the operator catalog (ZP-ENT-03). Every write runs in an admin unit of
 * work together with its tamper-evident audit entry; reads use the pool. Changes invalidate the
 * viewer-side catalog cache (all instances, through the coherent cache).
 */
export class CatalogAdminService {
  constructor(
    private readonly deps: {
      catalog: OperatorCatalogRepository;
      uow: AdminUnitOfWork;
      adapters: ProviderAdapters;
      connections: ProviderConnections;
      secrets: SecretStore;
      sync: Pick<ProviderSyncService, 'attach'>;
      jobs?: JobKicker;
      clock: Clock;
      /** Development providers (channel list typed into the console); off in production. */
      allowMockProviders: boolean;
      /** Clears viewer-side caches after a change. */
      onChange: () => void;
      /** List columns of the console (feeds, rights, health). */
      channelStats?: ConsoleQueries['channelStats'];
      /** Four-eyes control (new grants wait for approval; revocations are reviewed afterwards). */
      changes?: Pick<ChangeRequestService, 'propose' | 'recordForReview'>;
      /** A rights grant was revoked: viewings it allowed must stop now (not at the next heartbeat). */
      onRightsRevoked?: (channelId: string) => Promise<unknown>;
    },
  ) {}

  // --- providers -------------------------------------------------------------------------------

  async providers(): Promise<ProviderDto[]> {
    return (await this.deps.catalog.listProviders()).map(toProviderDto);
  }

  async createProvider(actor: StaffPrincipal, input: CreateProviderRequest, context: AdminContext): Promise<ProviderDto> {
    if (input.type === 'mock' && !this.deps.allowMockProviders) throw AppError.validation('Mock providers are disabled on this server.');
    if (input.type !== 'mock' && input.config?.['channels'] !== undefined) throw AppError.validation('Only mock providers take a channel list.');
    const slug = slugify(input.slug ?? input.name);
    const credential = input.credential ? await this.credential(input.type, input.credential) : null;
    if (input.type !== 'mock' && !credential) throw AppError.validation('This provider type needs credentials.');
    const id = this.deps.catalog.newId();
    const created = await this.write(async (catalog, audit) => {
      const provider = await catalog.createProvider({
        id,
        slug,
        name: input.name.trim(),
        type: input.type,
        config: input.config ?? {},
        host: credential?.host ?? (input.type === 'mock' ? 'mock' : ''),
        syncIntervalHours: input.syncIntervalHours ?? 6,
        secretRef: credential?.ref ?? null,
      });
      await audit(actor, context, 'provider.created', 'provider', id, null, providerState(provider), { slug, type: input.type, credential: credential ? credentialSource(credential.ref) : null });
      return provider;
    }, 'A provider with this slug already exists.');
    this.deps.jobs?.kick(PROVIDER_SYNC_JOB);
    return toProviderDto(created);
  }

  async updateProvider(actor: StaffPrincipal, id: string, input: UpdateProviderRequest, context: AdminContext): Promise<ProviderDto> {
    const before = await this.requireProvider(id);
    if (before.type !== 'mock' && input.config?.['channels'] !== undefined) throw AppError.validation('Only mock providers take a channel list.');
    const after = await this.write(async (catalog, audit) => {
      const updated = await catalog.updateProvider(id, {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.syncIntervalHours !== undefined ? { syncIntervalHours: input.syncIntervalHours } : {}),
        ...(input.contract ? { contract: contractPatch(input.contract, before.contract) } : {}),
      });
      if (!updated) throw AppError.notFound('Provider');
      await audit(actor, context, 'provider.updated', 'provider', id, providerState(before), providerState(updated), { changes: Object.keys(input) });
      // A new channel list (mock) or a reactivated provider is picked up by the next sync.
      if (input.config !== undefined || (input.status === 'active' && before.status !== 'active')) await catalog.requestProviderSync(id, this.deps.clock.now());
      return updated;
    });
    if (after.status === 'active') this.deps.jobs?.kick(PROVIDER_SYNC_JOB);
    return toProviderDto((await this.deps.catalog.findProvider(id)) ?? after);
  }

  async rotateCredential(actor: StaffPrincipal, id: string, input: ProviderCredentialInput, context: AdminContext): Promise<ProviderDto> {
    const provider = await this.requireProvider(id);
    const credential = await this.credential(provider.type, input);
    const now = this.deps.clock.now();
    await this.write(async (catalog, audit) => {
      await catalog.setCredential(id, credential.ref, now);
      await catalog.updateProvider(id, { host: credential.host });
      await audit(actor, context, 'provider.credential_rotated', 'provider', id, null, null, { credential: credentialSource(credential.ref) });
    });
    await this.deps.catalog.requestProviderSync(id, now);
    this.deps.jobs?.kick(PROVIDER_SYNC_JOB);
    return toProviderDto(await this.requireProvider(id));
  }

  async requestSync(actor: StaffPrincipal, id: string, context: AdminContext): Promise<ProviderDto> {
    await this.requireProvider(id);
    await this.write(async (catalog, audit) => {
      await catalog.requestProviderSync(id, this.deps.clock.now());
      await audit(actor, context, 'provider.sync_requested', 'provider', id, null, null, {});
    });
    this.deps.jobs?.kick(PROVIDER_SYNC_JOB);
    return toProviderDto(await this.requireProvider(id));
  }

  async health(id: string): Promise<ProviderHealthDto> {
    const provider = await this.requireProvider(id);
    try {
      const connection = await this.deps.connections.open(provider);
      return await this.deps.adapters[provider.type].health(provider, connection, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
    } catch (error) {
      return { ok: false, latencyMs: 0, message: error instanceof Error ? error.message : 'Unreachable' };
    }
  }

  // --- ingestion review --------------------------------------------------------------------------

  async reviewQueue(query: { providerId?: string | undefined; status: ProviderStreamStatus; offset: number; limit: number }): Promise<ProviderStreamPageDto> {
    const page = await this.deps.catalog.reviewQueue(query);
    const suggested = new Map((await this.deps.catalog.findChannels(page.items.map((item) => item.suggestion).filter((id): id is string => Boolean(id)))).map((channel) => [channel.id, channel]));
    return { items: page.items.map((stream) => toStreamDto(stream, suggested)), total: page.total };
  }

  /**
   * Decision on a stream: match it to a curated channel, create a new master channel from it, or
   * ignore it. Matching and creating record the stream's dedup keys as aliases, so the same
   * channel from other providers (and later syncs) is recognised automatically.
   */
  async review(actor: StaffPrincipal, streamId: string, decision: ReviewStreamRequest, context: AdminContext): Promise<ProviderStreamDto> {
    if (!(await this.deps.catalog.findStream(streamId))) throw AppError.notFound('Stream');
    await this.write(async (catalog, audit) => {
      // Decided on the locked current state: concurrent reviewers and the sync worker serialise here.
      const stream = (await catalog.findStream(streamId, { lock: true }))!;
      if (stream.status === 'gone') throw new AppError('CONFLICT', 409, 'The provider no longer offers this stream.');
      if (decision.action === 'create' && stream.status === 'matched') throw new AppError('CONFLICT', 409, 'This stream is already matched to a channel; match it to another one instead.');
      switch (decision.action) {
        case 'ignore': {
          const feed = await catalog.findFeedByStream(stream.id);
          if (feed) await catalog.deleteFeed(feed.id);
          await catalog.setStreamState(stream.id, { status: 'ignored', channelId: null, matchMethod: null });
          await audit(actor, context, 'stream.ignored', 'provider_stream', stream.id, streamState(stream), { ...streamState(stream), status: 'ignored' }, { name: stream.name });
          return;
        }
        case 'match': {
          const channel = await catalog.findChannel(decision.channelId);
          if (!channel) throw AppError.notFound('Channel');
          await catalog.addAliases(channel.id, aliasKeys(stream));
          await this.deps.sync.attach(stream, channel.id, 'manual', catalog);
          await audit(actor, context, 'stream.matched', 'provider_stream', stream.id, streamState(stream), { ...streamState(stream), status: 'matched', channelId: channel.id }, { channelId: channel.id, name: stream.name });
          return;
        }
        case 'create': {
          const channel = await this.newChannel(catalog, {
            name: decision.name ?? stream.name,
            originCountry: decision.originCountry ?? null,
            languages: decision.languages ?? [],
            categoryId: decision.categoryId ?? null,
            logo: stream.logo,
            globalUid: null,
          });
          await catalog.addAliases(channel.id, aliasKeys(stream));
          await this.deps.sync.attach(stream, channel.id, 'manual', catalog);
          await audit(actor, context, 'channel.created', 'channel', channel.id, null, channelState(channel), { fromStream: stream.id });
          await audit(actor, context, 'stream.matched', 'provider_stream', stream.id, streamState(stream), { ...streamState(stream), status: 'matched', channelId: channel.id }, { channelId: channel.id, name: stream.name });
          return;
        }
      }
    });
    const updated = (await this.deps.catalog.findStream(streamId))!;
    const suggestion = updated.suggestion ? await this.deps.catalog.findChannels([updated.suggestion]) : [];
    return toStreamDto(updated, new Map(suggestion.map((channel) => [channel.id, channel])));
  }

  // --- categories & channels ---------------------------------------------------------------------

  async categories(): Promise<CategoryDto[]> {
    return this.deps.catalog.listCategories();
  }

  async createCategory(actor: StaffPrincipal, input: { name: string; slug?: string | undefined }, context: AdminContext): Promise<CategoryDto> {
    const category = { id: this.deps.catalog.newId(), slug: slugify(input.slug ?? input.name), name: input.name.trim() };
    return this.write(async (catalog, audit) => {
      const created = await catalog.createCategory(category);
      await audit(actor, context, 'category.created', 'category', created.id, null, created, {});
      return created;
    }, 'A category with this slug already exists.');
  }

  async channels(query: { text?: string | undefined; status?: 'active' | 'hidden' | undefined; offset: number; limit: number }): Promise<MasterChannelPageDto> {
    const page = await this.deps.catalog.listChannels(query);
    const stats = this.deps.channelStats ? await this.deps.channelStats(page.items.map((channel) => channel.id)) : new Map();
    return {
      items: page.items.map((channel) => {
        const counts = stats.get(channel.id);
        return { ...toChannelDto(channel), feeds: counts?.feeds ?? 0, playableFeeds: counts?.playableFeeds ?? 0, activeGrants: counts?.activeGrants ?? 0, health: (counts?.health ?? null) as MasterChannelStatsDto['health'] };
      }),
      total: page.total,
    };
  }

  async channel(id: string): Promise<MasterChannelDetailDto> {
    const channel = await this.requireChannel(id);
    const [aliases, feeds, grants, providers, lineups] = await Promise.all([
      this.deps.catalog.aliasesOf(id),
      this.deps.catalog.feedsOf([id]),
      this.deps.catalog.grantsOf([id]),
      this.deps.catalog.listProviders(),
      this.deps.catalog.listLineups(),
    ]);
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
    const streams = new Map((await Promise.all(feeds.map((feed) => this.deps.catalog.findStream(feed.providerStreamId)))).filter((s): s is ProviderStreamRecord => Boolean(s)).map((s) => [s.id, s]));
    const playable = new Set(playableFeeds(feeds).map((feed) => feed.id));
    const numbering = await Promise.all(lineups.map(async (lineup) => ({ lineup, number: (await this.deps.catalog.lineupEntries(lineup.id)).find((entry) => entry.channelId === id)?.number })));
    return {
      ...toChannelDto(channel),
      aliases,
      feeds: feeds.map((feed) => toFeedDto(feed, providerNames.get(feed.providerId) ?? '', streams.get(feed.providerStreamId)?.name ?? '', playable.has(feed.id))),
      grants: grants.map(toGrantDto),
      lineups: numbering.filter((entry) => entry.number !== undefined).map((entry) => ({ id: entry.lineup.id, slug: entry.lineup.slug, number: entry.number! })),
    };
  }

  async createChannel(actor: StaffPrincipal, input: CreateMasterChannelRequest, context: AdminContext): Promise<MasterChannelDetailDto> {
    const created = await this.write(async (catalog, audit) => {
      const channel = await this.newChannel(catalog, {
        name: input.name,
        originCountry: input.originCountry ?? null,
        languages: input.languages ?? [],
        categoryId: input.categoryId ?? null,
        logo: input.logo ?? null,
        globalUid: input.globalUid ?? null,
        ...(input.slug ? { slug: input.slug } : {}),
      });
      await catalog.addAliases(channel.id, aliasKeys({ name: channel.name, tvgId: channel.globalUid }));
      await audit(actor, context, 'channel.created', 'channel', channel.id, null, channelState(channel), {});
      return channel;
    }, 'A channel with this slug or global id already exists.');
    return this.channel(created.id);
  }

  async updateChannel(actor: StaffPrincipal, id: string, input: UpdateMasterChannelRequest, context: AdminContext): Promise<MasterChannelDetailDto> {
    const before = await this.requireChannel(id);
    this.validateChannelFields(input);
    await this.write(async (catalog, audit) => {
      const updated = await catalog.updateChannel(id, {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.slug !== undefined ? { slug: slugify(input.slug) } : {}),
        ...(input.originCountry !== undefined ? { originCountry: input.originCountry } : {}),
        ...(input.languages !== undefined ? { languages: input.languages } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.logo !== undefined ? { logo: input.logo } : {}),
        ...(input.globalUid !== undefined ? { globalUid: input.globalUid } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      if (!updated) throw AppError.notFound('Channel');
      if (input.aliases?.length) {
        // Manual aliases: extra names (other spellings) that should map to this channel.
        await catalog.addAliases(id, input.aliases.map((alias) => ({ kind: 'name' as const, key: normalizeChannelName(alias) })).filter((alias) => alias.key));
      }
      await audit(actor, context, 'channel.updated', 'channel', id, channelState(before), channelState(updated), { changes: Object.keys(input) });
    }, 'A channel with this slug or global id already exists.');
    return this.channel(id);
  }

  /** Manual dedup: `fromId` disappears into `intoId` (aliases, feeds, rights, lineups, favourites, history). */
  async mergeChannels(actor: StaffPrincipal, intoId: string, fromId: string, context: AdminContext): Promise<MasterChannelDetailDto> {
    if (intoId === fromId) throw AppError.validation('A channel cannot be merged into itself.');
    const [into, from] = await Promise.all([this.requireChannel(intoId), this.requireChannel(fromId)]);
    await this.write(async (catalog, audit, tx) => {
      // Rights and package membership are four-eyes data: a merge must not move or drop them
      // behind the approval flow. The operator revokes/moves them first (each change reviewed).
      const now = this.deps.clock.now();
      const grants = await catalog.grantsOf([from.id]);
      if (grants.some((grant) => grant.status === 'active' && (grant.endAt === null || grant.endAt > now))) {
        throw new AppError('CONFLICT', 409, `"${from.name}" still has active rights grants. Revoke them (or grant them on "${into.name}") before merging.`);
      }
      const packages = (await tx.commerce.packagesOfChannels([from.id])).get(from.id) ?? [];
      if (packages.length) {
        throw new AppError('CONFLICT', 409, `"${from.name}" is in ${packages.length} package(s). Remove it from them (via an approved package change) before merging.`);
      }
      await catalog.mergeChannels(from.id, into.id);
      await audit(actor, context, 'channel.merged', 'channel', into.id, channelState(from), channelState(into), { mergedChannelId: from.id, mergedName: from.name });
    });
    return this.channel(into.id);
  }

  // --- feeds -------------------------------------------------------------------------------------

  async updateFeed(actor: StaffPrincipal, id: string, input: UpdateFeedRequest, context: AdminContext): Promise<FeedDto> {
    const before = await this.deps.catalog.findFeed(id);
    if (!before) throw AppError.notFound('Feed');
    const after = await this.write(async (catalog, audit) => {
      const updated = await catalog.updateFeed(id, input);
      if (!updated) throw AppError.notFound('Feed');
      await audit(actor, context, 'feed.updated', 'feed', id, feedState(before), feedState(updated), { channelId: before.channelId });
      return updated;
    });
    const [provider, stream] = await Promise.all([this.deps.catalog.findProvider(after.providerId), this.deps.catalog.findStream(after.providerStreamId)]);
    return toFeedDto(after, provider?.name ?? '', stream?.name ?? '', playableFeeds([after]).length > 0);
  }

  async deleteFeed(actor: StaffPrincipal, id: string, context: AdminContext): Promise<void> {
    const feed = await this.deps.catalog.findFeed(id);
    if (!feed) throw AppError.notFound('Feed');
    await this.write(async (catalog, audit) => {
      await catalog.deleteFeed(id);
      // Ignored, not pending: its aliases would re-attach it on the next sync. Staff can match it
      // again from the review queue (status=ignored).
      await catalog.setStreamState(feed.providerStreamId, { status: 'ignored', channelId: null, matchMethod: null });
      await audit(actor, context, 'feed.deleted', 'feed', id, feedState(feed), null, { channelId: feed.channelId });
    });
  }

  // --- rights ------------------------------------------------------------------------------------

  /** A new rights grant: through four-eyes approval unless it is off. */
  async grant(actor: StaffPrincipal, channelId: string, input: CreateGrantRequest, context: AdminContext): Promise<GrantChange> {
    if (!this.deps.changes) throw new Error('Change requests are not wired');
    const outcome = await this.deps.changes.propose(actor, 'rights.grant', channelId, { ...input }, context);
    return outcome.status === 'pending' ? { status: 'pending', request: outcome.request } : { status: 'applied', grant: toGrantDto(outcome.result as StoredGrant) };
  }

  /** Four-eyes handler of new rights grants. */
  changeHandlers(): ChangeHandler[] {
    const grant: ChangeHandler = {
      kind: 'rights.grant',
      targetType: 'channel',
      prepare: async (payload, channelId) => {
        const input = payload as unknown as CreateGrantRequest;
        const channel = await this.requireChannel(channelId ?? '');
        const { startAt, endAt } = checkGrant(input);
        const span = `${startAt.toISOString().slice(0, 10)} → ${endAt ? endAt.toISOString().slice(0, 10) : 'open-ended'}`;
        return {
          payload: { ...input, contractRef: input.contractRef.trim() },
          summary: `Rights for “${channel.name}”: ${input.territory === '*' ? 'worldwide' : input.territory} · ${[...new Set(input.deviceClasses)].join(', ')} · ${[...new Set(input.businessModels)].join(', ')} · ${span}${input.catchupDays ? ` · catch-up ${input.catchupDays} d` : ''} · contract ${input.contractRef.trim()}`,
          base: revokedGrants(await this.deps.catalog.grantsOf([channel.id])),
        };
      },
      // A revocation on the channel after the request (an ended licence) makes the request stale:
      // approving it would quietly undo the revocation.
      current: async (tx, channelId) => revokedGrants(await tx.catalog.grantsOf([channelId])),
      apply: async (tx, actor, change, context) => {
        const input = change.payload as unknown as CreateGrantRequest;
        const channelId = change.targetId ?? '';
        if (!(await tx.catalog.findChannel(channelId))) throw AppError.notFound('Channel');
        const { startAt, endAt } = checkGrant(input);
        if (endAt && endAt <= this.deps.clock.now()) throw AppError.validation('This grant has already ended; ask for a new one.');
        const devices = [...new Set(input.deviceClasses)].sort().join(',');
        const models = [...new Set(input.businessModels)].sort().join(',');
        const duplicate = (await tx.catalog.grantsOf([channelId])).find(
          (grant) =>
            grant.status === 'active' &&
            grant.territory === input.territory &&
            grant.contractRef === input.contractRef.trim() &&
            grant.startAt.getTime() === startAt.getTime() &&
            (grant.endAt?.getTime() ?? null) === (endAt?.getTime() ?? null) &&
            grant.catchupDays === (input.catchupDays ?? 0) &&
            [...grant.deviceClasses].sort().join(',') === devices &&
            [...grant.businessModels].sort().join(',') === models,
        );
        if (duplicate) throw new AppError('CONFLICT', 409, 'An identical grant already exists on this channel.');
        const created = await tx.catalog.createGrant({
          id: tx.catalog.newId(),
          channelId,
          territory: input.territory,
          deviceClasses: [...new Set(input.deviceClasses)],
          businessModels: [...new Set(input.businessModels)],
          startAt,
          endAt,
          contractRef: input.contractRef.trim(),
          catchupDays: input.catchupDays ?? 0,
          // The person who asked for it; the approver is in the audit entry.
          createdBy: change.requestedBy,
        });
        await tx.audit.append({
          ...actorOf(actor, context),
          occurredAt: this.deps.clock.now(),
          action: 'rights.granted',
          targetType: 'rights_grant',
          targetId: created.id,
          beforeHash: stateHash(null),
          afterHash: stateHash(grantState(created)),
          details: { channelId, territory: created.territory, contractRef: created.contractRef, changeRequest: change.requestId, requestedBy: change.requestedBy },
        });
        return { targetId: channelId, result: created };
      },
      afterCommit: async () => this.deps.onChange(),
    };
    return [grant];
  }

  async revokeGrant(actor: StaffPrincipal, grantId: string, context: AdminContext): Promise<RightsGrantDto> {
    const before = await this.deps.catalog.findGrant(grantId);
    if (!before) throw AppError.notFound('Grant');
    // Applied at once (a licence ended must not wait for a second person); reviewed afterwards.
    const revoked = await this.write(async (catalog, audit, tx) => {
      const after = await catalog.revokeGrant(grantId, this.deps.clock.now());
      if (!after) throw new AppError('CONFLICT', 409, 'This grant is already revoked.');
      await audit(actor, context, 'rights.revoked', 'rights_grant', grantId, grantState(before), grantState(after), { channelId: before.channelId });
      const channel = await catalog.findChannel(before.channelId);
      await this.deps.changes?.recordForReview(
        tx,
        actor,
        { kind: 'rights.revoke', targetType: 'rights_grant', targetId: grantId, payload: { channelId: before.channelId, grant: toGrantDto(before) }, summary: `Revoked rights for “${channel?.name ?? before.channelId}”: ${before.territory === '*' ? 'worldwide' : before.territory} · ${before.deviceClasses.join(', ')} · ${before.businessModels.join(', ')} · contract ${before.contractRef}` },
        context,
      );
      return after;
    });
    await this.deps.onRightsRevoked?.(before.channelId);
    return toGrantDto(revoked);
  }

  // --- lineups -----------------------------------------------------------------------------------

  async lineups(): Promise<LineupDto[]> {
    return this.deps.catalog.listLineups();
  }

  async lineup(idOrSlug: string): Promise<LineupDetailDto> {
    const lineup = await this.deps.catalog.findLineup(idOrSlug);
    if (!lineup) throw AppError.notFound('Lineup');
    const entries = await this.deps.catalog.lineupEntries(lineup.id);
    const names = new Map((await this.deps.catalog.findChannels(entries.map((entry) => entry.channelId))).map((channel) => [channel.id, channel.name]));
    return { ...lineup, entries: entries.map((entry) => ({ ...entry, name: names.get(entry.channelId) ?? '' })) };
  }

  async createLineup(actor: StaffPrincipal, input: CreateLineupRequest, context: AdminContext): Promise<LineupDetailDto> {
    if (!isCountryCode(input.country)) throw AppError.validation('Country must be an ISO 3166-1 alpha-2 code.');
    const created = await this.write(async (catalog, audit) => {
      const lineup = await catalog.createLineup({ id: catalog.newId(), slug: slugify(input.slug ?? `${input.country}-${input.name}`), name: input.name.trim(), country: input.country, status: input.status ?? 'draft' });
      await audit(actor, context, 'lineup.created', 'lineup', lineup.id, null, lineup, {});
      return lineup;
    }, 'A lineup with this slug already exists.');
    return this.lineup(created.id);
  }

  async updateLineup(actor: StaffPrincipal, id: string, input: UpdateLineupRequest, context: AdminContext): Promise<LineupDetailDto> {
    const before = await this.deps.catalog.findLineup(id);
    if (!before) throw AppError.notFound('Lineup');
    if (input.entries) {
      const problem = validateLineup(input.entries);
      if (problem) throw AppError.validation(problem);
      const known = await this.deps.catalog.findChannels(input.entries.map((entry) => entry.channelId));
      if (known.length !== input.entries.length) throw AppError.validation('The lineup lists a channel that does not exist.');
    }
    await this.write(async (catalog, audit) => {
      const updated = await catalog.updateLineup(before.id, { ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.status !== undefined ? { status: input.status } : {}) });
      const beforeEntries = input.entries ? await catalog.lineupEntries(before.id) : null;
      if (input.entries) await catalog.setLineupEntries(before.id, input.entries);
      await audit(actor, context, 'lineup.updated', 'lineup', before.id, lineupState(before, beforeEntries), lineupState(updated ?? before, input.entries ?? null), { changes: Object.keys(input) });
    });
    return this.lineup(before.id);
  }

  // ---------------------------------------------------------------------------------------------

  private async write<T>(work: (catalog: OperatorCatalogRepository, audit: AuditWriter, tx: AdminTransaction) => Promise<T>, conflictMessage?: string): Promise<T> {
    try {
      const result = await this.deps.uow.run(async (tx) => {
        const audit: AuditWriter = async (actor, context, action, targetType, targetId, before, after, details) => {
          await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action, targetType, targetId, beforeHash: stateHash(before), afterHash: stateHash(after), details });
        };
        return work(tx.catalog, audit, tx);
      });
      this.deps.onChange();
      return result;
    } catch (error) {
      if (conflictMessage && isUniqueViolation(error)) throw new AppError('CONFLICT', 409, conflictMessage);
      throw error;
    }
  }

  private async newChannel(
    catalog: OperatorCatalogRepository,
    input: { name: string; slug?: string; originCountry: string | null; languages: string[]; categoryId: string | null; logo: string | null; globalUid: string | null },
  ): Promise<MasterChannelRecord> {
    this.validateChannelFields(input);
    const name = input.name.trim();
    if (!name) throw AppError.validation('Give the channel a name.');
    // Unique slug: "bbc-one", "bbc-one-2", …
    const base = slugify(input.slug ?? name);
    let slug = base;
    for (let n = 2; await catalog.slugExists(slug); n++) slug = `${base}-${n}`;
    return catalog.createChannel({ id: catalog.newId(), slug, name, originCountry: input.originCountry, languages: input.languages, categoryId: input.categoryId, logo: input.logo, globalUid: input.globalUid, status: 'active' });
  }

  private validateChannelFields(input: { originCountry?: string | null | undefined; languages?: string[] | undefined }): void {
    if (input.originCountry && !isCountryCode(input.originCountry)) throw AppError.validation('Origin country must be an ISO 3166-1 alpha-2 code.');
    if (input.languages?.some((language) => !isLanguageCode(language))) throw AppError.validation('Languages must be ISO 639 codes (e.g. "ka", "en").');
  }

  private async credential(type: ProviderRecord['type'], input: ProviderCredentialInput): Promise<{ ref: string; host: string }> {
    if ('secretRef' in input) {
      if (!ENV_REF.test(input.secretRef)) throw AppError.validation('Secret references look like env:ZIPTV_SECRET_NAME.');
      let raw: string;
      try {
        raw = await this.deps.secrets.resolve(input.secretRef);
      } catch {
        throw AppError.validation('That secret is not set on the server.');
      }
      return { ref: input.secretRef, host: this.deps.connections.hostOf(this.deps.connections.parse(type, raw)) };
    }
    const raw = JSON.stringify(input.connection);
    const connection = this.deps.connections.parse(type, raw);
    return { ref: this.deps.secrets.seal(raw), host: this.deps.connections.hostOf(connection) };
  }

  private async requireProvider(id: string): Promise<ProviderRecord> {
    const provider = await this.deps.catalog.findProvider(id);
    if (!provider) throw AppError.notFound('Provider');
    return provider;
  }

  private async requireChannel(id: string): Promise<MasterChannelRecord> {
    const channel = await this.deps.catalog.findChannel(id);
    if (!channel) throw AppError.notFound('Channel');
    return channel;
  }
}

export type GrantChange = { status: 'applied'; grant: RightsGrantDto } | { status: 'pending'; request: ChangeRequestDto };

/** Territory and dates of a grant; throws when they make no sense. */
function checkGrant(input: CreateGrantRequest): { startAt: Date; endAt: Date | null } {
  if (!isTerritory(input.territory)) throw AppError.validation('Territory must be an ISO 3166-1 alpha-2 code or "*".');
  const startAt = new Date(input.startAt);
  const endAt = input.endAt ? new Date(input.endAt) : null;
  if (endAt && endAt <= startAt) throw AppError.validation('The end of a grant must be after its start.');
  if (input.catchupDays !== undefined && (!Number.isInteger(input.catchupDays) || input.catchupDays < 0 || input.catchupDays > 30)) throw AppError.validation('Catch-up days must be between 0 and 30.');
  return { startAt, endAt };
}

type AuditWriter = (
  actor: StaffPrincipal,
  context: AdminContext,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  details: Record<string, unknown>,
) => Promise<void>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** "env:ZIPTV_SECRET_X" stays visible (it is a name, not a secret); stored values never are. */
function credentialSource(ref: string): string {
  return ref.startsWith('env:') ? ref : 'stored';
}

// --- audit states (what before/after hashes cover) ---------------------------------------------

const providerState = (provider: ProviderRecord) => ({ name: provider.name, status: provider.status, type: provider.type, config: provider.config, syncIntervalHours: provider.syncIntervalHours, contract: provider.contract });
const streamState = (stream: ProviderStreamRecord) => ({ status: stream.status, channelId: stream.channelId });
const channelState = (channel: MasterChannelRecord) => ({
  name: channel.name,
  slug: channel.slug,
  originCountry: channel.originCountry,
  languages: channel.languages,
  categoryId: channel.categoryId,
  logo: channel.logo,
  globalUid: channel.globalUid,
  status: channel.status,
});
const feedState = (feed: FeedRecord) => ({ channelId: feed.channelId, providerStreamId: feed.providerStreamId, priority: feed.priority, status: feed.status });
const grantState = (grant: StoredGrant) => ({
  channelId: grant.channelId,
  territory: grant.territory,
  deviceClasses: grant.deviceClasses,
  businessModels: grant.businessModels,
  startAt: grant.startAt,
  endAt: grant.endAt,
  contractRef: grant.contractRef,
  catchupDays: grant.catchupDays,
  status: grant.status,
});
const lineupState = (lineup: LineupRecord, entries: { channelId: string; number: number }[] | null) => ({ name: lineup.name, status: lineup.status, country: lineup.country, ...(entries ? { entries } : {}) });

// --- DTOs ----------------------------------------------------------------------------------------

function toProviderDto(provider: ProviderRecord): ProviderDto {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    type: provider.type,
    status: provider.status,
    host: provider.host,
    syncIntervalHours: provider.syncIntervalHours,
    sync: {
      status: provider.sync.status,
      lastAttemptAt: provider.sync.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: provider.sync.lastSuccessAt?.toISOString() ?? null,
      nextAt: provider.sync.nextAt?.toISOString() ?? null,
      error: provider.sync.error,
    },
    stats: provider.stats,
    credential: provider.credential ? { source: credentialSource(provider.credential.secretRef), rotatedAt: provider.credential.rotatedAt.toISOString() } : null,
    contract: {
      ref: provider.contract.ref,
      startAt: provider.contract.startAt?.toISOString() ?? null,
      endAt: provider.contract.endAt?.toISOString() ?? null,
      slaTargetPct: provider.contract.slaTargetPct,
      monthlyCost: provider.contract.monthlyCostMinor !== null && provider.contract.costCurrency ? { currency: provider.contract.costCurrency, amountMinor: provider.contract.monthlyCostMinor } : null,
      notes: provider.contract.notes,
    },
    createdAt: provider.createdAt.toISOString(),
  };
}

/** Contract fields of a provider update (null clears a field). */
function contractPatch(input: NonNullable<UpdateProviderRequest['contract']>, current: ProviderContract): Partial<ProviderContract> {
  const startAt = input.startAt === undefined ? undefined : input.startAt ? new Date(input.startAt) : null;
  const endAt = input.endAt === undefined ? undefined : input.endAt ? new Date(input.endAt) : null;
  // Checked against the stored value of the field that is not being changed.
  const start = startAt === undefined ? current.startAt : startAt;
  const end = endAt === undefined ? current.endAt : endAt;
  if (start && end && end <= start) throw AppError.validation('The contract must end after it starts.');
  return {
    ...(input.ref !== undefined ? { ref: input.ref?.trim() || null } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    ...(input.slaTargetPct !== undefined ? { slaTargetPct: input.slaTargetPct } : {}),
    ...(input.monthlyCost !== undefined ? { monthlyCostMinor: input.monthlyCost?.amountMinor ?? null, costCurrency: input.monthlyCost?.currency.toUpperCase() ?? null } : {}),
    ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
  };
}

function toStreamDto(stream: ProviderStreamRecord, channels: Map<string, MasterChannelRecord>): ProviderStreamDto {
  const suggestion = stream.suggestion ? channels.get(stream.suggestion) : undefined;
  return {
    id: stream.id,
    providerId: stream.providerId,
    externalId: stream.externalId,
    name: stream.name,
    tvgId: stream.tvgId,
    groups: stream.groups,
    logo: stream.logo,
    kind: stream.kind,
    status: stream.status,
    channelId: stream.channelId,
    matchMethod: stream.matchMethod,
    suggestion: suggestion ? { id: suggestion.id, name: suggestion.name } : null,
    firstSeenAt: stream.firstSeenAt.toISOString(),
    lastSeenAt: stream.lastSeenAt.toISOString(),
  };
}

function toChannelDto(channel: MasterChannelRecord): MasterChannelDto {
  return {
    id: channel.id,
    slug: channel.slug,
    name: channel.name,
    originCountry: channel.originCountry,
    languages: channel.languages,
    categoryId: channel.categoryId,
    logo: channel.logo,
    globalUid: channel.globalUid,
    status: channel.status,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

function toFeedDto(feed: FeedRecord, providerName: string, streamName: string, playable: boolean): FeedDto {
  return { id: feed.id, providerId: feed.providerId, providerName, streamId: feed.providerStreamId, streamName, priority: feed.priority, status: feed.status, playable };
}

function toGrantDto(grant: StoredGrant): RightsGrantDto {
  return {
    id: grant.id,
    territory: grant.territory,
    deviceClasses: [...grant.deviceClasses],
    businessModels: [...grant.businessModels],
    startAt: grant.startAt.toISOString(),
    endAt: grant.endAt?.toISOString() ?? null,
    contractRef: grant.contractRef,
    catchupDays: grant.catchupDays,
    status: grant.status,
    createdAt: grant.createdAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}

/** Revoked grant ids of a channel, sorted: the staleness base of a pending rights request. */
function revokedGrants(grants: readonly StoredGrant[]): string[] {
  return grants
    .filter((grant) => grant.status === 'revoked')
    .map((grant) => grant.id)
    .sort();
}
