import mongoose, { Schema } from 'mongoose';

import type { ParsedChannel, StreamHeaders, StreamKind, UnplayableReason } from '../m3u/index.js';

/** Full channel as stored — includes the stream URL and headers, which never leave the server in lists. */
export interface ChannelRecord {
  key: string;
  position: number;
  name: string;
  groups: string[];
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  url: string;
  headers: StreamHeaders;
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  duration: number;
  attributes: Record<string, string>;
}

export type ChannelSummary = Pick<ChannelRecord, 'key' | 'name' | 'groups' | 'logo' | 'tvgId' | 'kind' | 'unplayableReason'>;

export interface ChannelRepository {
  insertRevision(playlistId: string, revision: number, channels: ParsedChannel[]): Promise<void>;
  listSummaries(playlistId: string, revision: number): Promise<ChannelSummary[]>;
  findByKey(playlistId: string, revision: number, key: string): Promise<ChannelRecord | null>;
  deleteRevision(playlistId: string, revision: number): Promise<void>;
  deleteRevisionsExcept(playlistId: string, revision: number): Promise<void>;
  deleteAll(playlistId: string): Promise<void>;
}

const channelSchema = new Schema(
  {
    playlistId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    position: { type: Number, required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    groups: { type: [String], default: [] },
    logo: { type: String, default: null },
    tvgId: { type: String, default: null },
    tvgName: { type: String, default: null },
    url: { type: String, required: true },
    headers: { type: Schema.Types.Mixed, default: {} },
    kind: { type: String, required: true },
    unplayableReason: { type: String, default: null },
    duration: { type: Number, default: -1 },
    attributes: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'channels', versionKey: false, minimize: false },
);
// Channel list (ordered) and single-channel lookup both hit one compound index each.
channelSchema.index({ playlistId: 1, revision: 1, position: 1 });
channelSchema.index({ playlistId: 1, revision: 1, key: 1 }, { unique: true });

export const ChannelModel = mongoose.model('Channel', channelSchema);

const INSERT_BATCH = 2000;
const SUMMARY_PROJECTION = { _id: 0, key: 1, name: 1, groups: 1, logo: 1, tvgId: 1, kind: 1, unplayableReason: 1 } as const;

type ChannelDoc = ChannelRecord & { playlistId: mongoose.Types.ObjectId; revision: number };

export class MongoChannelRepository implements ChannelRepository {
  async insertRevision(playlistId: string, revision: number, channels: ParsedChannel[]): Promise<void> {
    const playlistObjectId = new mongoose.Types.ObjectId(playlistId);
    for (let offset = 0; offset < channels.length; offset += INSERT_BATCH) {
      const batch = channels.slice(offset, offset + INSERT_BATCH).map((channel) => ({
        playlistId: playlistObjectId,
        revision,
        ...channel,
      }));
      // Parser output is already validated/normalised; `lean` skips per-document hydration.
      await ChannelModel.insertMany(batch, { ordered: true, lean: true });
    }
  }

  async listSummaries(playlistId: string, revision: number): Promise<ChannelSummary[]> {
    return ChannelModel.find({ playlistId, revision }, SUMMARY_PROJECTION).sort({ position: 1 }).lean<ChannelSummary[]>();
  }

  async findByKey(playlistId: string, revision: number, key: string): Promise<ChannelRecord | null> {
    const doc = await ChannelModel.findOne({ playlistId, revision, key }).lean<ChannelDoc>();
    if (!doc) return null;
    return {
      key: doc.key,
      position: doc.position,
      name: doc.name,
      groups: doc.groups ?? [],
      logo: doc.logo ?? null,
      tvgId: doc.tvgId ?? null,
      tvgName: doc.tvgName ?? null,
      url: doc.url,
      headers: doc.headers ?? {},
      kind: doc.kind,
      unplayableReason: doc.unplayableReason ?? null,
      duration: doc.duration ?? -1,
      attributes: doc.attributes ?? {},
    };
  }

  async deleteRevision(playlistId: string, revision: number): Promise<void> {
    await ChannelModel.deleteMany({ playlistId, revision });
  }

  async deleteRevisionsExcept(playlistId: string, revision: number): Promise<void> {
    await ChannelModel.deleteMany({ playlistId, revision: { $ne: revision } });
  }

  async deleteAll(playlistId: string): Promise<void> {
    await ChannelModel.deleteMany({ playlistId });
  }
}
