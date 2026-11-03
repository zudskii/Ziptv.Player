/**
 * Parental controls (pure rules). One PIN per account protects: content locks of each profile
 * (groups / channels, BYO and operator), PIN-protected profiles, and leaving a kids profile.
 *
 * Kids profiles are strict: adult and locked content does not exist for them (it is filtered out,
 * not shown as locked), the PIN never unlocks content there, and the rules cannot be changed from
 * a kids profile.
 */

/** 4–8 digits. */
const PIN_FORMAT = /^\d{4,8}$/;

export function isValidPin(pin: string): boolean {
  return PIN_FORMAT.test(pin);
}

/** A PIN anyone would guess first: one repeated digit, or a straight run (1234, 9876). */
export function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((digit, index) => digit - digits[index]!));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

/** Consecutive wrong PINs before the account's PIN is locked (counted atomically in the store). */
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;

/** Where a lock applies: a BYO source id, or `operator` for the licensed catalog. */
export const OPERATOR_LOCK_SOURCE = 'operator';

export const MAX_LOCKED_ITEMS = 500;

export interface LockedGroup {
  sourceId: string;
  group: string;
}

export interface LockedChannel {
  sourceId: string;
  key: string;
  /** Display only (the rule list in Settings). */
  name: string;
}

export interface ParentalRules {
  hideAdult: boolean;
  lockedGroups: LockedGroup[];
  lockedChannels: LockedChannel[];
  updatedAt: Date;
}

export const NO_RULES: ParentalRules = { hideAdult: false, lockedGroups: [], lockedChannels: [], updatedAt: new Date(0) };

/** Normalised, de-duplicated rule lists (trimmed, bounded). */
export function normaliseLocks(groups: readonly LockedGroup[], channels: readonly LockedChannel[]): { lockedGroups: LockedGroup[]; lockedChannels: LockedChannel[] } {
  const seenGroups = new Set<string>();
  const lockedGroups: LockedGroup[] = [];
  for (const item of groups) {
    const group = item.group.trim().slice(0, 200);
    const id = `${item.sourceId}|${group}`;
    if (!group || seenGroups.has(id)) continue;
    seenGroups.add(id);
    lockedGroups.push({ sourceId: item.sourceId, group });
  }
  const seenChannels = new Set<string>();
  const lockedChannels: LockedChannel[] = [];
  for (const item of channels) {
    const key = item.key.trim();
    const id = `${item.sourceId}|${key}`;
    if (!key || seenChannels.has(id)) continue;
    seenChannels.add(id);
    lockedChannels.push({ sourceId: item.sourceId, key, name: item.name.trim().slice(0, 200) || key });
  }
  return { lockedGroups, lockedChannels };
}
