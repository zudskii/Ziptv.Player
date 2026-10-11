import mongoose, { Schema } from 'mongoose';

import type {
  NewSource,
  RevisionSnapshot,
  SourceAccount,
  SourceHealth,
  SourceRecord,
  SourceRepository,
  SourceSettingsPatch,
  SyncOutcome,
} from '../../../../application/ports/source-repository.js';
import type { SyncStage } from '../../../../domain/sources/source.js';
import { isObjectId, newObjectId, oid, type ObjectIdType } from '../mongo-utils.js';

const warningSchema = new Schema({ line: Number, code: String, message: String }, { _id: false });

const sourceSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ['m3u_url', 'm3u_file', 'xtream'], required: true },
    origin: {
      kind: { type: String, required: true },
      host: String,
      fileName: String,
      username: String,
    },
    credential: { type: String, default: null },
    revision: { type: Number, required: true, default: 0 },
    epgVersion: { type: Number, required: true, default: 0 },
    stats: {
      live: { type: Number, default: 0 },
      movies: { type: Number, default: 0 },
      series: { type: Number, default: 0 },
      episodes: { type: Number, default: 0 },
      groups: { type: Number, default: 0 },
      unplayable: { type: Number, default: 0 },
      catchup: { type: Number, default: 0 },
      epgMapped: { type: Number, default: 0 },
    },
    sync: {
      status: { type: String, required: true },
      stage: { type: String, default: null },
      autoSync: { type: Boolean, default: true },
      intervalHours: { type: Number, default: 6 },
      lastAttemptAt: { type: Date, default: null },
      lastSuccessAt: { type: Date, default: null },
      nextSyncAt: { type: Date, default: null },
      error: { type: Schema.Types.Mixed, default: null },
      consecutiveFailures: { type: Number, default: 0 },
      rerunRequested: { type: Boolean, default: false },
    },
    lease: {
      owner: { type: String, default: null },
      until: { type: Date, default: null },
    },
    health: {
      state: { type: String, default: 'unknown' },
      checkedAt: { type: Date, default: null },
      latencyMs: { type: Number, default: null },
      unstableStreams: { type: Number, default: 0 },
      offlineStreams: { type: Number, default: 0 },
      message: { type: String, default: null },
    },
    account: { type: Schema.Types.Mixed, default: null },
    epgUrls: { type: [String], default: [] },
    warnings: { type: [warningSchema], default: [] },
    warningCount: { type: Number, default: 0 },
    format: { type: String, default: '' },
    encoding: { type: String, default: '' },
    xtreamCandidate: { type: Boolean, default: false },
    /** 2.x playlist this source was migrated from (same id). */
    legacyPlaylist: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'sources', minimize: false },
);
sourceSchema.index({ ownerId: 1, createdAt: 1 });
sourceSchema.index({ 'sync.status': 1, 'sync.nextSyncAt': 1 });

export const SourceModel = mongoose.model('Source', sourceSchema);

interface SourceDoc extends Omit<SourceRecord, 'id' | 'ownerId' | 'account'> {
  _id: ObjectIdType;
  ownerId: ObjectIdType;
  account: (Omit<SourceAccount, 'expiresAt'> & { expiresAt: Date | string | null }) | null;
}

function toRecord(doc: SourceDoc): SourceRecord {
  return {
    id: doc._id.toHexString(),
    ownerId: doc.ownerId.toHexString(),
    name: doc.name,
    type: doc.type,
    origin: toOrigin(doc.origin as unknown as Record<string, string | undefined>),
    credential: doc.credential ?? null,
    revision: doc.revision ?? 0,
    epgVersion: doc.epgVersion ?? 0,
    stats: {
      live: doc.stats?.live ?? 0,
      movies: doc.stats?.movies ?? 0,
      series: doc.stats?.series ?? 0,
      episodes: doc.stats?.episodes ?? 0,
      groups: doc.stats?.groups ?? 0,
      unplayable: doc.stats?.unplayable ?? 0,
      catchup: doc.stats?.catchup ?? 0,
      epgMapped: doc.stats?.epgMapped ?? 0,
    },
    sync: {
      status: doc.sync.status,
      stage: doc.sync.stage ?? null,
      autoSync: doc.sync.autoSync ?? true,
      intervalHours: doc.sync.intervalHours ?? 6,
      lastAttemptAt: doc.sync.lastAttemptAt ?? null,
      lastSuccessAt: doc.sync.lastSuccessAt ?? null,
      nextSyncAt: doc.sync.nextSyncAt ?? null,
      error: doc.sync.error ?? null,
      consecutiveFailures: doc.sync.consecutiveFailures ?? 0,
      rerunRequested: doc.sync.rerunRequested ?? false,
    },
    health: {
      state: doc.health?.state ?? 'unknown',
      checkedAt: doc.health?.checkedAt ?? null,
      latencyMs: doc.health?.latencyMs ?? null,
      unstableStreams: doc.health?.unstableStreams ?? 0,
      offlineStreams: doc.health?.offlineStreams ?? 0,
      message: doc.health?.message ?? null,
    },
    account: doc.account
      ? {
          status: doc.account.status,
          expiresAt: doc.account.expiresAt ? new Date(doc.account.expiresAt) : null,
          maxConnections: doc.account.maxConnections ?? null,
          activeConnections: doc.account.activeConnections ?? null,
          trial: doc.account.trial ?? false,
        }
      : null,
    epgUrls: doc.epgUrls ?? [],
    warnings: (doc.warnings ?? []).map((w) => ({ line: w.line, code: w.code, message: w.message })),
    warningCount: doc.warningCount ?? 0,
    format: doc.format ?? '',
    encoding: doc.encoding ?? '',
    xtreamCandidate: doc.xtreamCandidate ?? false,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toOrigin(origin: Record<string, string | undefined>): SourceRecord['origin'] {
  switch (origin.kind) {
    case 'file':
      return { kind: 'file', fileName: origin.fileName ?? '' };
    case 'xtream':
      return { kind: 'xtream', host: origin.host ?? '', username: origin.username ?? '' };
    default:
      return { kind: 'url', host: origin.host ?? '' };
  }
}

const leaseFree = (now: Date) => ({ $or: [{ 'lease.until': null }, { 'lease.until': { $lt: now } }] });

export class MongoSourceRepository implements SourceRepository {
  newId(): string {
    return newObjectId();
  }

  isValidId(id: string): boolean {
    return isObjectId(id);
  }

  countByOwner(ownerId: string): Promise<number> {
    return SourceModel.countDocuments({ ownerId: oid(ownerId) });
  }

  async listByOwner(ownerId: string): Promise<SourceRecord[]> {
    const docs = await SourceModel.find({ ownerId: oid(ownerId) }).sort({ createdAt: 1 }).lean<SourceDoc[]>();
    return docs.map(toRecord);
  }

  async findOwned(id: string, ownerId: string): Promise<SourceRecord | null> {
    if (!isObjectId(id)) return null;
    const doc = await SourceModel.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async findById(id: string): Promise<SourceRecord | null> {
    if (!isObjectId(id)) return null;
    const doc = await SourceModel.findById(id).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async create(source: NewSource): Promise<SourceRecord> {
    const doc = await SourceModel.create({
      _id: oid(source.id),
      ownerId: oid(source.ownerId),
      name: source.name,
      type: source.type,
      origin: source.origin,
      credential: source.credential,
      sync: source.sync,
    });
    return toRecord(doc.toObject() as unknown as SourceDoc);
  }

  async updateSettings(id: string, ownerId: string, patch: SourceSettingsPatch): Promise<SourceRecord | null> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.autoSync !== undefined) set['sync.autoSync'] = patch.autoSync;
    if (patch.intervalHours !== undefined) set['sync.intervalHours'] = patch.intervalHours;
    if (patch.nextSyncAt !== undefined) set['sync.nextSyncAt'] = patch.nextSyncAt;
    if (patch.credential !== undefined) set.credential = patch.credential;
    if (patch.origin !== undefined) set.origin = patch.origin;
    const doc = await SourceModel.findOneAndUpdate({ _id: oid(id), ownerId: oid(ownerId) }, { $set: set }, { new: true }).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const result = await SourceModel.deleteOne({ _id: oid(id), ownerId: oid(ownerId) });
    return result.deletedCount === 1;
  }

  async listAllIds(): Promise<{ id: string; ownerId: string }[]> {
    const docs = await SourceModel.find({}, { _id: 1, ownerId: 1 }).lean<{ _id: ObjectIdType; ownerId: ObjectIdType }[]>();
    return docs.map((doc) => ({ id: doc._id.toHexString(), ownerId: doc.ownerId.toHexString() }));
  }

  async requestSync(id: string, now: Date): Promise<SourceRecord | null> {
    // Not running (or a dead lease): queue it.
    const queued = await SourceModel.findOneAndUpdate(
      { _id: oid(id), ...leaseFree(now) },
      { $set: { 'sync.status': 'queued', 'sync.nextSyncAt': now, 'sync.rerunRequested': false } },
      { new: true },
    ).lean<SourceDoc>();
    if (queued) return toRecord(queued);
    // Running right now: run again as soon as it finishes (it may already have read old data).
    const flagged = await SourceModel.findOneAndUpdate({ _id: oid(id) }, { $set: { 'sync.rerunRequested': true } }, { new: true }).lean<SourceDoc>();
    return flagged ? toRecord(flagged) : null;
  }

  async claimDue(now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null> {
    const doc = await SourceModel.findOneAndUpdate(
      {
        type: { $ne: 'm3u_file' },
        $and: [
          leaseFree(now),
          {
            $or: [
              { 'sync.status': { $in: ['queued', 'running'] } },
              { 'sync.autoSync': true, 'sync.nextSyncAt': { $lte: now } },
            ],
          },
        ],
      },
      this.claimUpdate(now, owner, leaseUntil),
      { new: true, sort: { 'sync.nextSyncAt': 1 } },
    ).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async claim(id: string, now: Date, owner: string, leaseUntil: Date): Promise<SourceRecord | null> {
    const doc = await SourceModel.findOneAndUpdate({ _id: oid(id), ...leaseFree(now) }, this.claimUpdate(now, owner, leaseUntil), { new: true }).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async heartbeat(id: string, owner: string, leaseUntil: Date): Promise<boolean> {
    const result = await SourceModel.updateOne({ _id: oid(id), 'lease.owner': owner }, { $set: { 'lease.until': leaseUntil } });
    return result.matchedCount === 1;
  }

  async setStage(id: string, owner: string, stage: SyncStage): Promise<void> {
    await SourceModel.updateOne({ _id: oid(id), 'lease.owner': owner }, { $set: { 'sync.stage': stage } });
  }

  async commitRevision(id: string, owner: string, expectedRevision: number, snapshot: RevisionSnapshot): Promise<SourceRecord | null> {
    const doc = await SourceModel.findOneAndUpdate(
      { _id: oid(id), revision: expectedRevision, 'lease.owner': owner },
      {
        $set: {
          revision: snapshot.revision,
          stats: snapshot.stats,
          epgUrls: snapshot.epgUrls,
          warnings: snapshot.warnings,
          warningCount: snapshot.warningCount,
          format: snapshot.format,
          encoding: snapshot.encoding,
          xtreamCandidate: snapshot.xtreamCandidate,
          ...(snapshot.account ? { account: snapshot.account } : {}),
        },
      },
      { new: true },
    ).lean<SourceDoc>();
    return doc ? toRecord(doc) : null;
  }

  async completeSync(id: string, owner: string, outcome: SyncOutcome): Promise<SourceRecord | null> {
    const set: Record<string, unknown> = {
      'sync.status': outcome.status,
      'sync.stage': null,
      'sync.error': outcome.error,
      'sync.nextSyncAt': outcome.nextSyncAt,
      'sync.consecutiveFailures': outcome.consecutiveFailures,
      'lease.owner': null,
      'lease.until': null,
    };
    if (outcome.lastSuccessAt) set['sync.lastSuccessAt'] = outcome.lastSuccessAt;
    if (outcome.account) set.account = outcome.account;
    const doc = await SourceModel.findOneAndUpdate({ _id: oid(id), 'lease.owner': owner }, { $set: set }, { new: true }).lean<SourceDoc>();
    if (!doc) return null;
    if (doc.sync.rerunRequested) {
      const rerun = await SourceModel.findOneAndUpdate(
        { _id: doc._id, 'lease.owner': null },
        { $set: { 'sync.status': 'queued', 'sync.nextSyncAt': new Date(), 'sync.rerunRequested': false } },
        { new: true },
      ).lean<SourceDoc>();
      return toRecord(rerun ?? doc);
    }
    return toRecord(doc);
  }

  async setEpgState(id: string, revision: number, epgMapped: number, linksChanged: boolean): Promise<void> {
    await SourceModel.updateOne(
      { _id: oid(id), revision },
      { $set: { 'stats.epgMapped': epgMapped }, ...(linksChanged ? { $inc: { epgVersion: 1 } } : {}) },
    );
  }

  async updateHealth(id: string, health: SourceHealth): Promise<void> {
    await SourceModel.updateOne({ _id: oid(id) }, { $set: { health } });
  }

  async updateAccount(id: string, account: SourceAccount): Promise<void> {
    await SourceModel.updateOne({ _id: oid(id) }, { $set: { account } });
  }

  private claimUpdate(now: Date, owner: string, leaseUntil: Date) {
    return {
      $set: {
        'lease.owner': owner,
        'lease.until': leaseUntil,
        'sync.status': 'running',
        'sync.stage': 'connecting',
        'sync.lastAttemptAt': now,
        'sync.rerunRequested': false,
      },
    };
  }
}
