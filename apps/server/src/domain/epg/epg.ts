/**
 * EPG domain rules: XMLTV time format, programme state (now/next, progress), retention window
 * and how live channels are matched to guide channels.
 *
 *   EPG Source (guide) ── EPG Channel ── EPG Programme
 *   Live channel ── EPG Mapping (manual) / tvg-id / name ──▶ EPG Channel
 */
import type { EpgLink } from '../catalog/model.js';
import { normalizeChannelName } from '../shared/text.js';

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

const XMLTV_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/;

/** "20261001143000 +0400" → Date. Missing offset = UTC (XMLTV default). */
export function parseXmltvTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const match = XMLTV_TIME.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00', zone = '+0000'] = match;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.replace(/[+:-]/g, '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMinutes * 60_000;
  return Number.isFinite(utc) ? new Date(utc) : null;
}

// ---------------------------------------------------------------------------------------------
// Programmes
// ---------------------------------------------------------------------------------------------

export interface TimedProgramme {
  start: Date;
  stop: Date;
}

/** Current and following programme from a list sorted by start. */
export function nowAndNext<T extends TimedProgramme>(programmes: readonly T[], now: Date): { now: T | null; next: T | null } {
  const time = now.getTime();
  let current: T | null = null;
  for (const programme of programmes) {
    if (programme.start.getTime() <= time && programme.stop.getTime() > time) {
      current = programme;
      continue;
    }
    if (programme.start.getTime() > time) return { now: current, next: programme };
  }
  return { now: current, next: null };
}

/** 0..1 of a programme that is on air. */
export function programmeProgress(programme: TimedProgramme, now: Date): number {
  const span = programme.stop.getTime() - programme.start.getTime();
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - programme.start.getTime()) / span));
}

/** Past programme still inside the channel's archive window. */
export function isCatchupAvailable(programme: TimedProgramme, catchupDays: number | null | undefined, now: Date): boolean {
  if (!catchupDays || catchupDays <= 0) return false;
  return programme.stop.getTime() <= now.getTime() && programme.start.getTime() >= now.getTime() - catchupDays * 86_400_000;
}

/** "S2 E5" from `episode-num` (onscreen preferred; xmltv_ns is zero-based "s.e.p"). */
export function episodeLabel(values: { system: string; value: string }[]): string | null {
  const onscreen = values.find((item) => item.system === 'onscreen')?.value.trim();
  if (onscreen) return onscreen.slice(0, 40);
  const ns = values.find((item) => item.system === 'xmltv_ns')?.value;
  if (!ns) return null;
  const [season, episode] = ns.split('.').map((part) => part.split('/')[0]?.trim() ?? '');
  const s = season ? Number(season) + 1 : null;
  const e = episode ? Number(episode) + 1 : null;
  if (s !== null && Number.isFinite(s) && e !== null && Number.isFinite(e)) return `S${s} E${e}`;
  if (e !== null && Number.isFinite(e)) return `E${e}`;
  return null;
}

/**
 * Which programmes a guide sync keeps: from the start of the archive window (catch-up needs the
 * past) to `daysAhead` in the future. Everything else in a 300 MB XMLTV is skipped.
 */
export function retentionWindow(now: Date, maxCatchupDays: number, daysAhead: number): { from: Date; to: Date } {
  const pastDays = Math.max(1, Math.min(30, maxCatchupDays));
  return { from: new Date(now.getTime() - pastDays * 86_400_000), to: new Date(now.getTime() + daysAhead * 86_400_000) };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export interface GuideChannelIndex {
  guideId: string;
  /** lower-case XMLTV channel id → channel id. */
  byId: Map<string, string>;
  /** compact normalised display name → channel id (first wins). */
  byName: Map<string, string>;
}

/**
 * Name identity used for matching: the normalised name without spaces, so "Rustavi 2" matches
 * the id "Rustavi2.ge" and "BBC One" matches "BBCOne.uk".
 */
export function matchKey(nameKey: string): string {
  return nameKey.replace(/\s+/g, '');
}

/** Name identity of an XMLTV channel id ("BBCOne.uk" → "bbcone"). */
export function idMatchKey(id: string): string {
  return matchKey(normalizeChannelName(id.replace(/\.[a-z]{2,3}$/i, '').replace(/[._-]+/g, ' ')));
}

export function buildGuideIndex(guideId: string, channels: { id: string; names: string[] }[]): GuideChannelIndex {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const channel of channels) {
    byId.set(channel.id.toLowerCase(), channel.id);
    for (const name of channel.names) {
      const key = matchKey(normalizeChannelName(name));
      if (key && !byName.has(key)) byName.set(key, channel.id);
    }
    // Ids like "BBCOne.uk" double as names when display-names are missing.
    const idName = idMatchKey(channel.id);
    if (idName && !byName.has(idName)) byName.set(idName, channel.id);
  }
  return { guideId, byId, byName };
}

export interface MatchTarget {
  key: string;
  tvgId: string | null;
  xtreamEpgId: string | null;
  nameKey: string;
}

/**
 * Links a live channel to a guide channel. Priority:
 *   1. manual mapping (the user picked it)        → "manual"
 *   2. tvg-id / Xtream epg_channel_id, exact     → "tvg-id"
 *   3. normalised name ("UK: BBC One HD" = "BBC One") → "name"
 * Guides are tried in priority order (the source's own guides before manually added ones).
 */
export function matchChannel(
  target: MatchTarget,
  manual: { guideId: string; epgChannelId: string } | undefined,
  guides: readonly GuideChannelIndex[],
): EpgLink | null {
  if (manual && guides.some((guide) => guide.guideId === manual.guideId && guide.byId.has(manual.epgChannelId.toLowerCase()))) {
    return { guideId: manual.guideId, epgChannelId: manual.epgChannelId, match: 'manual' };
  }
  const ids = [target.tvgId, target.xtreamEpgId].filter((id): id is string => !!id).map((id) => id.toLowerCase());
  for (const guide of guides) {
    for (const id of ids) {
      const found = guide.byId.get(id);
      if (found) return { guideId: guide.guideId, epgChannelId: found, match: 'tvg-id' };
    }
  }
  const nameKey = matchKey(target.nameKey);
  if (nameKey) {
    for (const guide of guides) {
      const found = guide.byName.get(nameKey);
      if (found) return { guideId: guide.guideId, epgChannelId: found, match: 'name' };
    }
  }
  return null;
}

export function sameLink(a: EpgLink | null, b: EpgLink | null): boolean {
  if (!a || !b) return a === b;
  return a.guideId === b.guideId && a.epgChannelId === b.epgChannelId && a.match === b.match;
}
