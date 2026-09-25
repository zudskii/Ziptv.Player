import type { StreamKind, UnplayableReason } from '@ziptv/contracts';

export type { StreamKind, UnplayableReason };

/** Upstream request headers a channel needs (lower-case names, whitelisted). */
export type StreamHeaders = Partial<Record<AllowedStreamHeader, string>>;

export type AllowedStreamHeader = 'user-agent' | 'referer' | 'origin' | 'cookie' | 'authorization';

export type ParseWarningCode =
  | 'orphan_extinf'
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'drm_protected'
  | 'web_page'
  | 'invalid_directive'
  | 'truncated';

export interface ParseWarning {
  /** 1-based line number, 0 when not tied to a specific line. */
  line: number;
  code: ParseWarningCode;
  message: string;
}

export interface ParsedChannel {
  /** Stable, URL-safe identity (see channel-key.ts). */
  key: string;
  /** Order in the source playlist (0-based). */
  position: number;
  name: string;
  /** Group labels ([] = no group). Case/whitespace variants are unified; `a;b` is split. */
  groups: string[];
  logo: string | null;
  tvgId: string | null;
  tvgName: string | null;
  /** Absolute stream URL without Kodi-style `|Header=...` suffix. */
  url: string;
  headers: StreamHeaders;
  kind: StreamKind;
  unplayableReason: UnplayableReason | null;
  /** EXTINF duration (-1 for live). */
  duration: number;
  /** All EXTINF attributes as found (lower-cased keys), so nothing from the source is lost. */
  attributes: Record<string, string>;
}

export type PlaylistFormat = 'm3u' | 'pls' | 'hls-manifest';

export interface ParsedPlaylist {
  format: PlaylistFormat;
  encoding: string;
  /** `#PLAYLIST:` title, if present. */
  title: string | null;
  epgUrls: string[];
  channels: ParsedChannel[];
  /** Capped list; see `warningCount` for the total. */
  warnings: ParseWarning[];
  warningCount: number;
  truncated: boolean;
}

export interface ParseOptions {
  /** Base for resolving relative stream/logo URLs (the playlist URL for URL imports). */
  baseUrl?: URL;
  /** Hard cap on entries; the rest is dropped with a `truncated` warning. */
  maxChannels?: number;
  /** Cap on stored warnings (the total is still counted). */
  maxWarnings?: number;
}

/** Intermediate entry produced by format-specific parsers, before key/group finalisation. */
export interface RawEntry {
  line: number;
  uri: string;
  title: string;
  duration: number;
  attributes: Record<string, string>;
  /** `#EXTGRP:` value attached to this entry. */
  extGroup: string | null;
  /** `#EXTIMG:` value attached to this entry. */
  extImage: string | null;
  /** Headers gathered from EXTVLCOPT / EXTHTTP / KODIPROP, in source order. */
  headers: StreamHeaders;
  drm: boolean;
  /** Container declared by the playlist itself (e.g. KODIPROP manifest_type=mpd). */
  kindHint: StreamKind | null;
}
