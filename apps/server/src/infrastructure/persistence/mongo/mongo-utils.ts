import mongoose from 'mongoose';

export const ObjectId = mongoose.Types.ObjectId;
export type ObjectIdType = mongoose.Types.ObjectId;

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

export function oid(value: string): ObjectIdType {
  return new ObjectId(value);
}

export function newObjectId(): string {
  return new ObjectId().toHexString();
}

export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

/** Untyped view of a model for generic maintenance queries (deleteMany over several collections). */
export type AnyModel = mongoose.Model<Record<string, unknown>>;

export function anyModel(model: unknown): AnyModel {
  return model as AnyModel;
}

/** Inserts large arrays in bounded batches (memory and BSON-size friendly). */
export async function insertInBatches<T>(model: unknown, docs: T[], batchSize = 2_000): Promise<void> {
  for (let offset = 0; offset < docs.length; offset += batchSize) {
    await anyModel(model).insertMany(docs.slice(offset, offset + batchSize) as Record<string, unknown>[], { ordered: true, lean: true });
  }
}

/** Default schema options of catalog-like collections: no __v, keep empty objects. */
export const LEAN_SCHEMA_OPTIONS = { versionKey: false, minimize: false } as const;
