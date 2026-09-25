/**
 * M3U domain module — pure functions, no I/O, no framework imports.
 * Everything the rest of the server needs from playlist parsing goes through this barrel.
 */
export { parsePlaylistBytes, parsePlaylistText, PlaylistFormatError } from './parse-playlist.js';
export { detectStreamKind } from './stream-kind.js';
export { hasHeaders } from './stream-headers.js';
export type {
  ParsedChannel,
  ParsedPlaylist,
  ParseOptions,
  ParseWarning,
  PlaylistFormat,
  StreamHeaders,
  StreamKind,
  UnplayableReason,
} from './types.js';
