import mongoose, { Schema } from 'mongoose';

import type {
  AddedAtIndex,
  CatalogRepository,
  LiveChannelSummary,
  LiveLinkTarget,
  RevisionData,
  SourceRevisionRef,
  StoredEpisode,
  StoredLiveChannel,
  StoredMovie,
  StoredSeries,
} from '../../../../application/ports/catalog-repository.js';
import type { EpgLink } from '../../../../domain/catalog/model.js';
import { anyModel, insertInBatches, LEAN_SCHEMA_OPTIONS, oid, type ObjectIdType } from '../mongo-utils.js';

// ---------------------------------------------------------------------------------------------
// Schemas: one document per item per source revision. Readers pin `{ sourceId, revision }`.
// ---------------------------------------------------------------------------------------------

const epgLinkSchema = new Schema({ guideId: String, epgChannelId: String, match: String }, { _id: false });
const catchupSchema = new Schema({ mode: String, days: Number, template: String }, { _id: false });

const liveSchema = new Schema(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    key: { type: String, required: true },
    position: { type: Number, required: true },
    name: { type: String, required: true },
    groups: { type: [String], default: [] },
    logo: { type: String, default: null },
    tvgId: { type: String, default: null },
    tvgName: { type: String, default: null },
    kind: { type: String, required: true },
    unplayableReason: { type: String, default: null },
    locator: { type: String, default: null },
    catchup: { type: catchupSchema, default: null },
    adult: { type: Boolean, default: false },
    xtream: { type: Schema.Types.Mixed, default: null },
    addedAt: { type: Date, default: null },
    epg: { type: epgLinkSchema, default: null },
    nameKey: { type: String, default: '' },
    searchTokens: { type: [String], default: [] },
  },
  { collection: 'live_channels', ...LEAN_SCHEMA_OPTIONS },
);
liveSchema.index({ sourceId: 1, revision: 1, position: 1 });
liveSchema.index({ sourceId: 1, revision: 1, key: 1 }, { unique: true });
liveSchema.index({ sourceId: 1, revision: 1, nameKey: 1 });
liveSchema.index({ sourceId: 1, revision: 1, searchTokens: 1 });

const movieSchema = new Schema(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    key: { type: String, required: true },
    position: { type: Number, required: true },
    name: { type: String, required: true },
    year: { type: Number, default: null },
    groups: { type: [String], default: [] },
    poster: { type: String, default: null },
    rating: { type: Number, default: null },
    genres: { type: [String], default: [] },
    durationSecs: { type: Number, default: null },
    plot: { type: String, default: null },
    kind: { type: String, required: true },
    locator: { type: String, default: null },
    adult: { type: Boolean, default: false },
    xtream: { type: Schema.Types.Mixed, default: null },
    addedAt: { type: Date, default: null },
    searchTokens: { type: [String], default: [] },
  },
  { collection: 'movies', ...LEAN_SCHEMA_OPTIONS },
);
movieSchema.index({ sourceId: 1, revision: 1, position: 1 });
movieSchema.index({ sourceId: 1, revision: 1, key: 1 }, { unique: true });
movieSchema.index({ sourceId: 1, revision: 1, groups: 1, position: 1 });
movieSchema.index({ sourceId: 1, revision: 1, addedAt: -1 });
movieSchema.index({ sourceId: 1, revision: 1, searchTokens: 1 });

const seriesSchema = new Schema(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    key: { type: String, required: true },
    position: { type: Number, required: true },
    name: { type: String, required: true },
    year: { type: Number, default: null },
    groups: { type: [String], default: [] },
    cover: { type: String, default: null },
    rating: { type: Number, default: null },
    genres: { type: [String], default: [] },
    plot: { type: String, default: null },
    adult: { type: Boolean, default: false },
    xtream: { type: Schema.Types.Mixed, default: null },
    addedAt: { type: Date, default: null },
    searchTokens: { type: [String], default: [] },
    /** Xtream: when seasons/episodes were last loaded (lazily, on first open). */
    detailsFetchedAt: { type: Date, default: null },
  },
  { collection: 'series', ...LEAN_SCHEMA_OPTIONS },
);
seriesSchema.index({ sourceId: 1, revision: 1, position: 1 });
seriesSchema.index({ sourceId: 1, revision: 1, key: 1 }, { unique: true });
seriesSchema.index({ sourceId: 1, revision: 1, groups: 1, position: 1 });
seriesSchema.index({ sourceId: 1, revision: 1, addedAt: -1 });
seriesSchema.index({ sourceId: 1, revision: 1, searchTokens: 1 });

const episodeSchema = new Schema(
  {
    sourceId: { type: Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true },
    seriesKey: { type: String, required: true },
    key: { type: String, required: true },
    season: { type: Number, required: true },
    episode: { type: Number, required: true },
    title: { type: String, required: true },
    plot: { type: String, default: null },
    durationSecs: { type: Number, default: null },
    still: { type: String, default: null },
    airDate: { type: String, default: null },
    kind: { type: String, required: true },
    locator: { type: String, default: null },
    xtream: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'episodes', ...LEAN_SCHEMA_OPTIONS },
);
episodeSchema.index({ sourceId: 1, revision: 1, seriesKey: 1, season: 1, episode: 1 });
episodeSchema.index({ sourceId: 1, revision: 1, seriesKey: 1, key: 1 }, { unique: true });

export const LiveChannelModel = mongoose.model('LiveChannel', liveSchema);
export const MovieModel = mongoose.model('Movie', movieSchema);
export const SeriesModel = mongoose.model('Series', seriesSchema);
export const EpisodeModel = mongoose.model('Episode', episodeSchema);

const CATALOG_MODELS = [LiveChannelModel, MovieModel, SeriesModel, EpisodeModel] as const;

const SUMMARY_PROJECTION = {
  _id: 0,
  key: 1,
  position: 1,
  name: 1,
  groups: 1,
  logo: 1,
  tvgId: 1,
  kind: 1,
  unplayableReason: 1,
  catchup: 1,
  adult: 1,
  xtream: 1,
  addedAt: 1,
  epg: 1,
  nameKey: 1,
} as const;

type LiveDoc = StoredLiveChannel & { sourceId: ObjectIdType; revision: number };

export function toLiveSummary(doc: Partial<LiveDoc>): LiveChannelSummary {
  return {
    key: doc.key ?? '',
    position: doc.position ?? 0,
    name: doc.name ?? '',
    groups: doc.groups ?? [],
    logo: doc.logo ?? null,
    tvgId: doc.tvgId ?? null,
    kind: doc.kind ?? 'unknown',
    unplayableReason: doc.unplayableReason ?? null,
    catchup: doc.catchup ?? null,
    adult: doc.adult ?? false,
    xtream: doc.xtream ?? null,
    addedAt: doc.addedAt ?? null,
    epg: doc.epg?.guideId ? doc.epg : null,
    nameKey: doc.nameKey ?? '',
  };
}

const pin = (ref: SourceRevisionRef) => ({ sourceId: oid(ref.sourceId), revision: ref.revision });

export class MongoCatalogRepository implements CatalogRepository {
  async insertRevision(sourceId: string, revision: number, data: RevisionData): Promise<void> {
    const base = { sourceId: oid(sourceId), revision };
    await insertInBatches(LiveChannelModel, data.live.map((item) => ({ ...base, ...item })));
    await insertInBatches(MovieModel, data.movies.map((item) => ({ ...base, ...item })));
    await insertInBatches(SeriesModel, data.series.map((item) => ({ ...base, ...item })));
    await insertInBatches(EpisodeModel, data.episodes.map((item) => ({ ...base, ...item })));
  }

  async deleteRevision(sourceId: string, revision: number): Promise<void> {
    await Promise.all(CATALOG_MODELS.map((model) => anyModel(model).deleteMany({ sourceId: oid(sourceId), revision })));
  }

  async deleteOtherRevisions(sourceId: string, keepRevision: number): Promise<void> {
    await Promise.all(
      CATALOG_MODELS.map((model) => anyModel(model).deleteMany({ sourceId: oid(sourceId), revision: { $ne: keepRevision } })),
    );
  }

  async deleteSource(sourceId: string): Promise<void> {
    await Promise.all(CATALOG_MODELS.map((model) => anyModel(model).deleteMany({ sourceId: oid(sourceId) })));
  }

  async addedAtIndex(sourceId: string, revision: number): Promise<AddedAtIndex> {
    const filter = { sourceId: oid(sourceId), revision };
    const read = async (model: unknown) => {
      const docs = await anyModel(model).find(filter, { _id: 0, key: 1, addedAt: 1 }).lean<{ key: string; addedAt: Date | null }[]>();
      return new Map(docs.map((doc) => [doc.key, doc.addedAt ?? null]));
    };
    const [live, movies, series] = await Promise.all([read(LiveChannelModel), read(MovieModel), read(SeriesModel)]);
    return { live, movies, series };
  }

  async listLive(ref: SourceRevisionRef): Promise<LiveChannelSummary[]> {
    const docs = await LiveChannelModel.find(pin(ref), SUMMARY_PROJECTION).sort({ position: 1 }).lean<Partial<LiveDoc>[]>();
    return docs.map(toLiveSummary);
  }

  async findLive(ref: SourceRevisionRef, key: string): Promise<StoredLiveChannel | null> {
    const doc = await LiveChannelModel.findOne({ ...pin(ref), key }, { _id: 0, sourceId: 0, revision: 0 }).lean<LiveDoc>();
    if (!doc) return null;
    return { ...toLiveSummary(doc), tvgName: doc.tvgName ?? null, locator: doc.locator ?? null, searchTokens: doc.searchTokens ?? [] };
  }

  async findLiveMany(ref: SourceRevisionRef, keys: string[]): Promise<LiveChannelSummary[]> {
    if (keys.length === 0) return [];
    const docs = await LiveChannelModel.find({ ...pin(ref), key: { $in: keys } }, SUMMARY_PROJECTION).lean<Partial<LiveDoc>[]>();
    return docs.map(toLiveSummary);
  }

  async findLiveByNameKey(refs: SourceRevisionRef[], nameKey: string, limit: number): Promise<(LiveChannelSummary & { sourceId: string })[]> {
    if (refs.length === 0 || !nameKey) return [];
    const docs = await LiveChannelModel.find({ $or: refs.map((ref) => ({ ...pin(ref), nameKey })) }, { ...SUMMARY_PROJECTION, sourceId: 1 })
      .limit(limit)
      .lean<Partial<LiveDoc>[]>();
    return docs.map((doc) => ({ ...toLiveSummary(doc), sourceId: (doc.sourceId as ObjectIdType).toHexString() }));
  }

  async liveLinkTargets(ref: SourceRevisionRef): Promise<LiveLinkTarget[]> {
    const docs = await LiveChannelModel.find(pin(ref), { _id: 0, key: 1, name: 1, nameKey: 1, tvgId: 1, xtream: 1, epg: 1 }).lean<Partial<LiveDoc>[]>();
    return docs.map((doc) => ({
      key: doc.key ?? '',
      name: doc.name ?? '',
      nameKey: doc.nameKey ?? '',
      tvgId: doc.tvgId ?? null,
      xtreamEpgId: (doc.xtream as { epgChannelId?: string | null } | null)?.epgChannelId ?? null,
      epg: doc.epg?.guideId ? doc.epg : null,
    }));
  }

  async setLiveEpgLinks(ref: SourceRevisionRef, changes: { key: string; epg: EpgLink | null }[]): Promise<void> {
    const filter = pin(ref);
    for (let offset = 0; offset < changes.length; offset += 1_000) {
      const batch = changes.slice(offset, offset + 1_000);
      await LiveChannelModel.bulkWrite(
        batch.map((change) => ({ updateOne: { filter: { ...filter, key: change.key }, update: { $set: { epg: change.epg } } } })),
        { ordered: false },
      );
    }
  }

  async findMovie(ref: SourceRevisionRef, key: string): Promise<StoredMovie | null> {
    return MovieModel.findOne({ ...pin(ref), key }, { _id: 0, sourceId: 0, revision: 0 }).lean<StoredMovie>();
  }

  async findSeries(ref: SourceRevisionRef, key: string): Promise<StoredSeries | null> {
    return SeriesModel.findOne({ ...pin(ref), key }, { _id: 0, sourceId: 0, revision: 0 }).lean<StoredSeries>();
  }

  async findEpisode(ref: SourceRevisionRef, seriesKey: string, key: string): Promise<StoredEpisode | null> {
    return EpisodeModel.findOne({ ...pin(ref), seriesKey, key }, { _id: 0, sourceId: 0, revision: 0 }).lean<StoredEpisode>();
  }

  async listEpisodes(ref: SourceRevisionRef, seriesKey: string): Promise<StoredEpisode[]> {
    return EpisodeModel.find({ ...pin(ref), seriesKey }, { _id: 0, sourceId: 0, revision: 0 }).sort({ season: 1, episode: 1 }).lean<StoredEpisode[]>();
  }
}
