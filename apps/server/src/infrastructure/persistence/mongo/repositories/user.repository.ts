import mongoose, { Schema, type InferSchemaType } from 'mongoose';

import type { UserRecord, UserRepository } from '../../../../application/ports/user-repository.js';

const userSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    /** Filled by the legacy migration script; removed once claimed. */
    legacySecretId: { type: String, unique: true, sparse: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'users' },
);

type UserDocument = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date };

export const UserModel = mongoose.model('User', userSchema);

function toRecord(doc: UserDocument): UserRecord {
  return { id: doc._id.toHexString(), createdAt: doc.createdAt, lastSeenAt: doc.lastSeenAt };
}

export class MongoUserRepository implements UserRepository {
  async create(tokenHash: string): Promise<UserRecord> {
    const doc = await UserModel.create({ tokenHash });
    return toRecord(doc.toObject() as UserDocument);
  }

  async findByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    const doc = await UserModel.findOne({ tokenHash }).lean<UserDocument>();
    return doc ? toRecord(doc) : null;
  }

  async claimLegacy(legacySecretId: string, tokenHash: string): Promise<UserRecord | null> {
    const doc = await UserModel.findOneAndUpdate(
      { legacySecretId },
      { $set: { tokenHash, lastSeenAt: new Date() }, $unset: { legacySecretId: 1 } },
      { new: true },
    ).lean<UserDocument>();
    return doc ? toRecord(doc) : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    await UserModel.updateOne({ _id: id }, { $set: { lastSeenAt: at } });
  }
}
