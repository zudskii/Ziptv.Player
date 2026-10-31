import type { CatchupInfo, StreamHeaders } from '../../domain/catalog/model.js';

/** One channel of an exported playlist, with its stream already decrypted. */
export interface ExportedChannel {
  name: string;
  number: number | null;
  logo: string | null;
  tvgId: string | null;
  groupName: string | null;
  url: string;
  headers: StreamHeaders;
  catchup: CatchupInfo | null;
}

/** Text format of an exported playlist (M3U today). */
export interface PlaylistFormatter {
  readonly contentType: string;
  header(): string;
  channel(channel: ExportedChannel): string;
}
