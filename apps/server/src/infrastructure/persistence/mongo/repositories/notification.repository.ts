import mongoose, { Schema } from 'mongoose';

import type { NewNotification, NotificationRecord, NotificationRepository } from '../../../../application/ports/notification-repository.js';
import { isObjectId, oid, type ObjectIdType } from '../mongo-utils.js';

const notificationSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    severity: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: null },
    link: { type: String, default: null },
    read: { type: Boolean, default: false },
    dedupeKey: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'notifications', versionKey: false },
);
notificationSchema.index({ ownerId: 1, createdAt: -1 });
notificationSchema.index({ ownerId: 1, dedupeKey: 1, read: 1 });
notificationSchema.index({ createdAt: 1 });

export const NotificationModel = mongoose.model('Notification', notificationSchema);

type NotificationDoc = Omit<NotificationRecord, 'id' | 'ownerId'> & { _id: ObjectIdType; ownerId: ObjectIdType };

function toRecord(doc: NotificationDoc): NotificationRecord {
  return {
    id: doc._id.toHexString(),
    ownerId: doc.ownerId.toHexString(),
    type: doc.type,
    severity: doc.severity,
    title: doc.title,
    body: doc.body ?? null,
    link: doc.link ?? null,
    read: doc.read ?? false,
    dedupeKey: doc.dedupeKey ?? null,
    createdAt: doc.createdAt,
  };
}

export class MongoNotificationRepository implements NotificationRepository {
  async upsert(notification: NewNotification, now: Date): Promise<NotificationRecord> {
    const fields = { ...notification, ownerId: oid(notification.ownerId), createdAt: now };
    if (notification.dedupeKey) {
      const doc = await NotificationModel.findOneAndUpdate(
        { ownerId: fields.ownerId, dedupeKey: notification.dedupeKey, read: false },
        { $set: fields },
        { upsert: true, new: true },
      ).lean<NotificationDoc>();
      if (doc) return toRecord(doc);
    }
    const created = await NotificationModel.create({ ...fields, read: false });
    return toRecord(created.toObject() as unknown as NotificationDoc);
  }

  async list(ownerId: string, limit: number): Promise<NotificationRecord[]> {
    const docs = await NotificationModel.find({ ownerId: oid(ownerId) }).sort({ createdAt: -1 }).limit(limit).lean<NotificationDoc[]>();
    return docs.map(toRecord);
  }

  unreadCount(ownerId: string): Promise<number> {
    return NotificationModel.countDocuments({ ownerId: oid(ownerId), read: false });
  }

  async markRead(ownerId: string, ids: string[] | 'all'): Promise<void> {
    const filter: Record<string, unknown> = { ownerId: oid(ownerId), read: false };
    if (ids !== 'all') filter._id = { $in: ids.filter(isObjectId).map(oid) };
    await NotificationModel.updateMany(filter, { $set: { read: true } });
  }

  async deleteOwned(ownerId: string, id: string): Promise<boolean> {
    if (!isObjectId(id)) return false;
    const result = await NotificationModel.deleteOne({ _id: oid(id), ownerId: oid(ownerId) });
    return result.deletedCount === 1;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await NotificationModel.deleteMany({ createdAt: { $lt: cutoff } });
    return result.deletedCount;
  }

  async deleteForOwner(ownerId: string): Promise<void> {
    await NotificationModel.deleteMany({ ownerId: oid(ownerId) });
  }
}
