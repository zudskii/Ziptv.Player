import mongoose, { Schema } from 'mongoose';

import type { ScheduleRepository } from '../../../../application/ports/schedule-repository.js';
import { isDuplicateKeyError } from '../mongo-utils.js';

const scheduleSchema = new Schema(
  {
    _id: { type: String, required: true },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lease: {
      owner: { type: String, default: null },
      until: { type: Date, default: null },
    },
  },
  { collection: 'schedules', versionKey: false },
);

export const ScheduleModel = mongoose.model('Schedule', scheduleSchema);

export class MongoScheduleRepository implements ScheduleRepository {
  async claim(job: string, owner: string, now: Date, intervalMs: number, leaseMs: number): Promise<boolean> {
    try {
      // Upsert: the first ever run inserts the document; afterwards the filter only matches
      // when the job is due and not leased — otherwise the upsert collides on _id (→ false).
      const doc = await ScheduleModel.findOneAndUpdate(
        {
          _id: job,
          $and: [
            { $or: [{ nextRunAt: null }, { nextRunAt: { $lte: now } }] },
            { $or: [{ 'lease.until': null }, { 'lease.until': { $lt: now } }] },
          ],
        },
        {
          $set: {
            'lease.owner': owner,
            'lease.until': new Date(now.getTime() + leaseMs),
            nextRunAt: new Date(now.getTime() + intervalMs),
            lastRunAt: now,
          },
        },
        { upsert: true, new: true },
      ).lean();
      return doc !== null;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async release(job: string, owner: string, outcome: { ok: boolean; error?: string }): Promise<void> {
    await ScheduleModel.updateOne(
      { _id: job, 'lease.owner': owner },
      { $set: { 'lease.owner': null, 'lease.until': null, lastError: outcome.ok ? null : (outcome.error ?? 'failed') } },
    );
  }
}
