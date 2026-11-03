import type { LockedChannel, LockedGroup, ParentalRules } from '../../domain/viewer/parental.js';

export interface ParentalPinRecord {
  userId: string;
  pinHash: string;
  /** Bumped on every change: unlock tokens of an older PIN stop working. */
  version: number;
  failures: number;
  lockedUntil: Date | null;
}

export interface ParentalRepository {
  findPin(userId: string): Promise<ParentalPinRecord | null>;
  /** Creates or replaces the PIN (version + 1, failures cleared). */
  savePin(userId: string, pinHash: string, now: Date): Promise<void>;
  deletePin(userId: string): Promise<void>;
  /**
   * Counts a wrong PIN atomically; at `maxFailures` in a row the PIN locks until `lockUntil` and the
   * count starts over. Returns the lock when this failure set it.
   */
  registerFailure(userId: string, maxFailures: number, lockUntil: Date): Promise<{ lockedUntil: Date | null }>;
  clearFailures(userId: string): Promise<void>;
  /** Rules of every profile of the account that has any. */
  rulesOf(userId: string): Promise<Map<string, ParentalRules>>;
  saveRules(profileId: string, rules: { hideAdult: boolean; lockedGroups: LockedGroup[]; lockedChannels: LockedChannel[] }, now: Date): Promise<void>;
  /** PIN removed: content locks go too (nothing could unlock them); "hide adult" stays. */
  clearLocks(userId: string, now: Date): Promise<void>;
}
