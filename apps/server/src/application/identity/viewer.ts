/**
 * Who is asking: the account (device identity) plus the active profile and its restrictions.
 * Every user-facing read goes through a Viewer, so profile scoping and parental rules are
 * applied in one place instead of in every route.
 */
export interface Viewer {
  userId: string;
  profileId: string;
  /** Kids profile: adult content is never shown, locked content is hidden. */
  kids: boolean;
  /** Adult groups/titles are filtered out of every list. */
  hideAdult: boolean;
  /** `${sourceId}|${group}` entries that need the PIN. */
  lockedGroups: ReadonlySet<string>;
  /** `${sourceId}|${channelKey}` entries that need the PIN. */
  lockedChannels: ReadonlySet<string>;
  /** A valid parental unlock token came with the request. */
  unlocked: boolean;
  /** Changes whenever the restrictions change (part of HTTP cache validators). */
  restrictionsVersion: string;
}

export function lockKey(sourceId: string, value: string): string {
  return `${sourceId}|${value}`;
}

/** Content that is filtered out for this viewer (not just locked). */
export function isHiddenForViewer(viewer: Viewer, item: { adult: boolean }): boolean {
  return item.adult && (viewer.kids || viewer.hideAdult);
}

/** Needs the PIN before it can be played (and, for kids, is hidden). */
export function isLockedForViewer(viewer: Viewer, sourceId: string, item: { key: string; groups: readonly string[] }): boolean {
  if (viewer.lockedChannels.has(lockKey(sourceId, item.key))) return true;
  return item.groups.some((group) => viewer.lockedGroups.has(lockKey(sourceId, group)));
}

/** A viewer without any restriction (tests, background jobs). */
export function unrestrictedViewer(userId: string, profileId = userId): Viewer {
  return {
    userId,
    profileId,
    kids: false,
    hideAdult: false,
    lockedGroups: new Set(),
    lockedChannels: new Set(),
    unlocked: false,
    restrictionsVersion: '0',
  };
}
