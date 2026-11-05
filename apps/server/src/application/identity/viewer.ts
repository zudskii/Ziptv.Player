/**
 * Who is asking: the account (device identity) plus the active profile and its restrictions.
 * Every user-facing read goes through a Viewer, so profile scoping and parental rules are
 * applied in one place instead of in every route.
 */
export interface Viewer {
  userId: string;
  /** The signed-in device the request came from (null for background work). Stream links are bound to it. */
  sessionId: string | null;
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
  /**
   * The account's sources this profile sees (its library); `null` = all of them (background work,
   * tests). Everything a viewer reads is scoped to it: catalog, search, Home, guide, My List,
   * history, notifications.
   */
  library: ReadonlySet<string> | null;
}

/** The profile sees this source (it is in its library). Ownership is checked separately. */
export function seesSource(viewer: Pick<Viewer, 'library'>, sourceId: string): boolean {
  return viewer.library === null || viewer.library.has(sourceId);
}

/** Only the sources in the viewer's library, in the same order. */
export function inLibrary<T extends { id: string }>(viewer: Pick<Viewer, 'library'>, sources: readonly T[]): T[] {
  return sources.filter((source) => seesSource(viewer, source.id));
}

export function lockKey(sourceId: string, value: string): string {
  return `${sourceId}|${value}`;
}

/**
 * Content that is filtered out for this viewer (not just locked): adult content when hidden, and
 * — for kids profiles, which never see locks — locked content too (needs `sourceId`).
 */
export function isHiddenForViewer(viewer: Viewer, item: { adult: boolean; key?: string; groups?: readonly string[] }, sourceId?: string): boolean {
  if (item.adult && (viewer.kids || viewer.hideAdult)) return true;
  return viewer.kids && sourceId !== undefined && item.key !== undefined && isLockedForViewer(viewer, sourceId, { key: item.key, groups: item.groups ?? [] });
}

/** Needs the PIN before it can be played (and, for kids, is hidden). */
export function isLockedForViewer(viewer: Viewer, sourceId: string, item: { key: string; groups: readonly string[] }): boolean {
  if (viewer.lockedChannels.has(lockKey(sourceId, item.key))) return true;
  return item.groups.some((group) => viewer.lockedGroups.has(lockKey(sourceId, group)));
}

/** A viewer without any restriction (tests, background jobs). */
export function unrestrictedViewer(userId: string, profileId = userId, sessionId: string | null = null): Viewer {
  return {
    userId,
    sessionId,
    profileId,
    kids: false,
    hideAdult: false,
    lockedGroups: new Set(),
    lockedChannels: new Set(),
    unlocked: false,
    restrictionsVersion: '0',
    library: null,
  };
}
