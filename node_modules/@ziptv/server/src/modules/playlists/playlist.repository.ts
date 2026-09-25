import mongoose, { Schema } from 'mongoose';

import type { ParseWarning } from '../m3u/index.js';

export type PlaylistSource = { type: 'file'; fileName: string } | { type: 'url'; url: string };

export interface PlaylistStats {
  channels: number;
  groups: number;
  unplayable: number;
}

/** Result of one successful import; replaced atomically on refresh. */
export interface PlaylistSnapshot {
  revision: number;
  stats: PlaylistStats;
  epgUrls: string[];
  warnings: ParseWarning[];
  warningCount: number;
  format: string;
  encoding: string;
  refreshedAt: Date;
}

export interface PlaylistRecord extends PlaylistSnapshot {
  id: string;
  ownerId: string;
  name: string;
  source: PlaylistSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaylistRepository {
  newId(): string;
  isValidId(id: string): boolean;
  countByOwner(ownerId: string): Promise<number>;
  listByOwner(ownerId: string): Promise<PlaylistRecord[]>;
  findOwned(id: string, ownerId: string): Promise<PlaylistRecord | null>;
  findById(id: string): Promise<PlaylistRecord | null>;
  create(input: { id: string; ownerId: string; name: string; source: PlaylistSource; snapshot: PlaylistSnapshot }): Promise<PlaylistRecord>;
  /** Compare-and-set on `revision`: returns null when another refresh won the race. */
  replaceSnapshot(id: string, expectedRevision: number, snapshot: PlaylistSnapshot): Promise<PlaylistRecord | null>;
  rename(id: string, ownerId: string, name: string): Promise<PlaylistRecord | null>;
  deleteOwned(id: string, ownerId: string): Promise<boolean>;
}

const warningSchema = new Schema({ line: Number, code: String, message: String }, { _id: false });

const playlistSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    source: {
      type: { type: String, enum: ['file', 'url'], required: true },
      fileName: String,
      url: String,
    },
    revision: { type: Number, required: true, min: 1 },
    stats: {
      channels: { type: Number, required: true },
      groups: { type: Number, required: true },
      unplayable: { type: Number, required: true },
    },
    epgUrls: { type: [String], default: [] },
    warnings: { type: [warningSchema], default: [] },
    warningCount: { type: Number, default: 0 },
    format: { type: String, required: true },
    encoding: { type: String, required: true },
    refreshedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'playlists' },
);
playlistSchema.index({ ownerId: 1, createdAt: 1 });

export const PlaylistModel = mongoose.model('Playlist', playlistSchema);

interface PlaylistDoc {
  _id: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  name: string;
  source: { type: 'file' | 'url'; fileName?: string | null; url?: string | null };
  revision: number;
  stats: PlaylistStats;
  epgUrls: string[];
  warnings: ParseWarning[];
  warningCount: number;
  format: string;
  encoding: string;
  refreshedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(doc: PlaylistDoc): PlaylistRecord {
  const source: PlaylistSource =
    doc.source.type === 'url' ? { type: 'url', url: doc.source.url ?? '' } : { type: 'file', fileName: doc.source.fileName ?? '' };
  return {
    id: doc._id.toHexString(),
    ownerId: doc.ownerId.toHexString(),
    name: doc.name,
    source,
    revision: doc.revision,
    stats: { channels: doc.stats.channels, groups: doc.stats.groups, unplayable: doc.stats.unplayable },
    epgUrls: doc.epgUrls ?? [],
    warnings: (doc.warnings ?? []).map((w) => ({ line: w.line, code: w.code, message: w.message })),
    warningCount: doc.warningCount ?? 0,
    format: doc.format,
    encoding: doc.encoding,
    refreshedAt: doc.refreshedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongoPlaylistRepository implements PlaylistRepository {
  newId(): string {
    return new mongoose.Types.ObjectId().toHexString();
  }

  isValidId(id: string): boolean {
    return /^[a-f0-9]{24}$/i.test(id);
  }

  countByOwner(ownerId: string): Promise<number> {
    return PlaylistModel.countDocuments({ ownerId });
  }

  async listByOwner(ownerId: string): Promise<PlaylistRecord[]> {
    const docs = await PlaylistModel.find({ ownerId }).sort({ createdAt: 1 }).lean<PlaylistDoc[]>();
    return docs.map(toRecord);
  }

  async findOwned(id: string, ownerId: string): Promise<PlaylistRecord | null> {
    const doc = await PlaylistModel.findOne({ _id: id, ownerId }).lean<PlaylistDoc>();
    return doc ? toRecord(doc) : null;
  }

  async findById(id: string): Promise<PlaylistRecord | null> {
    const doc = await PlaylistModel.findById(id).lean<PlaylistDoc>();
    return doc ? toRecord(doc) : null;
  }

  async create(input: {
    id: string;
    ownerId: string;
    name: string;
    source: PlaylistSource;
    snapshot: PlaylistSnapshot;
  }): Promise<PlaylistRecord> {
    const doc = await PlaylistModel.create({
      _id: input.id,
      ownerId: input.ownerId,
      name: input.name,
      source: input.source,
      ...input.snapshot,
    });
    return toRecord(doc.toObject() as unknown as PlaylistDoc);
  }

  async replaceSnapshot(id: string, expectedRevision: number, snapshot: PlaylistSnapshot): Promise<PlaylistRecord | null> {
    const doc = await PlaylistModel.findOneAndUpdate(
      { _id: id, revision: expectedRevision },
      { $set: snapshot },
      { new: true },
    ).lean<PlaylistDoc>();
    return doc ? toRecord(doc) : null;
  }

  async rename(id: string, ownerId: string, name: string): Promise<PlaylistRecord | null> {
    const doc = await PlaylistModel.findOneAndUpdate({ _id: id, ownerId }, { $set: { name } }, { new: true }).lean<PlaylistDoc>();
    return doc ? toRecord(doc) : null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const result = await PlaylistModel.deleteOne({ _id: id, ownerId });
    return result.deletedCount === 1;
  }
}
