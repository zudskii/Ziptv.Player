import { BUSINESS_MODELS, DEVICE_CLASSES, isTerritory, type BusinessModel, type DeviceClass } from './catalog.js';

/**
 * ZIPTV Vendor Feed, contract version 1 (Phase 16) — the format a content provider delivers its
 * catalogue and the rights that come with it in. Documented for vendors in docs/vendor-feed-v1.md.
 *
 * A feed is pulled over HTTPS (`GET <feed url>?since=<cursor>`), its body is JSON and it is signed
 * by the vendor (Ed25519, detached, over the exact body bytes). Unsigned or wrongly signed feeds
 * are refused whole; a malformed *item* is skipped and reported, the rest still applies.
 *
 * Incremental: the answer to `since=<cursor>` holds only what changed (`full: false`) plus a new
 * cursor; `full: true` is a complete snapshot (everything not in it is gone). The first sync, or
 * one after the vendor reset its cursors, is full.
 *
 * Pure: types, limits and the rights rules. Parsing/validation of the wire format lives in the
 * adapter (infrastructure).
 */
export const VENDOR_FEED_VERSION = 1;

export const QUALITIES = ['sd', 'hd', 'fhd', 'uhd'] as const;
export type Quality = (typeof QUALITIES)[number];

/** Highest picture height a quality cap allows (HLS variants above it are left out). */
export const QUALITY_HEIGHT: Record<Quality, number> = { sd: 576, hd: 720, fhd: 1080, uhd: 2160 };

export const FEED_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
  maxItems: 100_000,
  maxRightsPerItem: 50,
  /** A signed feed older than this is refused (a replayed old snapshot must not roll rights back). */
  maxAgeMs: 7 * 86_400_000,
} as const;

/** Rights as the vendor licenses an item: where, on what, under which models, when, catch-up and quality. */
export interface FeedRight {
  territories: string[];
  devices: DeviceClass[];
  models: BusinessModel[];
  start: Date;
  end: Date | null;
  catchupDays: number;
  maxQuality: Quality | null;
}

export interface FeedChannel {
  id: string;
  name: string;
  tvgId: string | null;
  logo: string | null;
  groups: string[];
  stream: { url: string; headers: Record<string, string> };
  catchup: { days: number; mode: 'shift' | 'xc' | 'append' | 'flussonic'; template: string | null } | null;
  rights: FeedRight[];
  packages: string[];
}

export interface FeedEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  durationSecs: number | null;
  stream: { url: string; headers: Record<string, string> };
}

export interface FeedVod {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  genres: string[];
  poster: string | null;
  plot: string | null;
  durationSecs: number | null;
  rating: number | null;
  /** Movies: the stream. Series: none (episodes carry theirs). */
  stream: { url: string; headers: Record<string, string> } | null;
  episodes: FeedEpisode[];
  rights: FeedRight[];
  packages: string[];
}

export interface FeedPackage {
  id: string;
  name: string;
  description: string | null;
}

/** One validated feed document. */
export interface VendorFeed {
  version: typeof VENDOR_FEED_VERSION;
  providerId: string;
  generatedAt: Date;
  cursor: string;
  full: boolean;
  channels: FeedChannel[];
  vod: FeedVod[];
  packages: FeedPackage[];
  deleted: { channels: string[]; vod: string[]; packages: string[] };
  epg: { xmltvUrls: string[] };
}

/** A problem with one item (skipped) or with the feed (refused). */
export interface FeedIssue {
  path: string;
  message: string;
}

/**
 * Validates one right beyond its shape: a real territory, a known device class and model, a
 * window that ends after it starts, catch-up within the 0–30 days the platform supports.
 */
export function checkRight(right: FeedRight): string | null {
  if (right.territories.length === 0) return 'territories is empty';
  const bad = right.territories.find((territory) => !isTerritory(territory));
  if (bad) return `territory "${bad}" is not an ISO 3166-1 alpha-2 code or "*"`;
  if (right.devices.length === 0 || right.devices.some((device) => !(DEVICE_CLASSES as readonly string[]).includes(device))) return 'devices must be web, mobile, tv or stb';
  if (right.models.length === 0 || right.models.some((model) => !(BUSINESS_MODELS as readonly string[]).includes(model))) return 'models must be subscription, fast or b2b';
  if (right.end && right.end.getTime() <= right.start.getTime()) return 'end is not after start';
  if (!Number.isInteger(right.catchupDays) || right.catchupDays < 0 || right.catchupDays > 30) return 'catchupDays must be 0–30';
  return null;
}

/**
 * A signed feed is applied only when it is newer than the last one applied and not too old:
 * otherwise an attacker (or a misconfigured mirror) replaying an old snapshot could roll rights back.
 */
export function freshnessProblem(generatedAt: Date, lastApplied: Date | null, now: Date): string | null {
  if (generatedAt.getTime() > now.getTime() + 5 * 60_000) return 'generatedAt is in the future';
  if (now.getTime() - generatedAt.getTime() > FEED_LIMITS.maxAgeMs) return 'the feed is older than 7 days';
  if (lastApplied && generatedAt.getTime() < lastApplied.getTime()) return 'the feed is older than the one already applied';
  return null;
}

/** One grant per (right × territory): rights_grants hold a single territory each. */
export function expandRights(rights: readonly FeedRight[]): { territory: string; right: FeedRight }[] {
  return rights.flatMap((right) => [...new Set(right.territories)].map((territory) => ({ territory, right })));
}

/** The licence terms of a grant, as far as the comparison with a feed needs them. */
export interface GrantTerms {
  territory: string;
  deviceClasses: readonly DeviceClass[];
  businessModels: readonly BusinessModel[];
  startAt: Date;
  endAt: Date | null;
  catchupDays: number;
}

/**
 * A staff grant that goes beyond what the provider licenses in its feed — a conflict for the
 * console: the operator would be offering more than it bought. Null = covered: one feed grant
 * alone covers its territory, devices, models, whole window and catch-up.
 */
export function beyondFeed(grant: GrantTerms, feed: readonly GrantTerms[]): string | null {
  const territory = feed.filter((right) => right.territory === '*' || right.territory === grant.territory);
  if (territory.length === 0) return `territory ${grant.territory} is not licensed by the provider`;
  const devices = territory.filter((right) => grant.deviceClasses.every((device) => right.deviceClasses.includes(device)));
  if (devices.length === 0) return `devices ${grant.deviceClasses.join(', ')} are not all licensed`;
  const models = devices.filter((right) => grant.businessModels.every((model) => right.businessModels.includes(model)));
  if (models.length === 0) return `business models ${grant.businessModels.join(', ')} are not all licensed`;
  const window = models.filter((right) => right.startAt.getTime() <= grant.startAt.getTime() && (right.endAt === null || (grant.endAt !== null && grant.endAt.getTime() <= right.endAt.getTime())));
  if (window.length === 0) return 'the grant runs outside the licensed window';
  if (!window.some((right) => right.catchupDays >= grant.catchupDays)) return `catch-up of ${grant.catchupDays} days exceeds the licensed catch-up`;
  return null;
}
