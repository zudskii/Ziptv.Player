import type { Logger } from '../ports/logger.js';
import type { MediaGrant, MediaUrls } from '../ports/media-urls.js';
import type { PlaylistFormatter } from '../ports/playlist-formatter.js';
import type { PlaylistEntryRepository, PlaylistRepository } from '../ports/playlist-repository.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { EXPORT_TOKEN_FORMAT, hashExportToken, type PlaylistExportMode } from './playlist.service.js';

/** Rows fetched per query: memory stays flat however long the playlist is. */
const BATCH = 2_000;

export interface OpenedExport {
  contentType: string;
  /** Pieces of the file, produced as they are read from the database. */
  chunks(): AsyncGenerator<string>;
}

/**
 * The public side of a playlist: turns an export link into the playlist file. The link's token
 * is the only credential, so everything unknown or malformed looks the same: "not found".
 *
 * In `proxied` mode no upstream address leaves the server: streams and logos become ZIPTV proxy
 * URLs bound to this export link (revoking the link stops them), stream headers stay inside the
 * encrypted tokens and catch-up templates (which embed provider URLs) are left out.
 */
export class PlaylistExportService {
  constructor(
    private readonly deps: {
      playlists: PlaylistRepository;
      entries: PlaylistEntryRepository;
      secrets: SourceSecrets;
      formatter: PlaylistFormatter;
      media: MediaUrls;
      mode: PlaylistExportMode;
      logger: Logger;
    },
  ) {}

  /** `origin`: absolute origin proxy URLs are written with (players need absolute URLs). */
  async open(token: string, origin: string): Promise<OpenedExport | null> {
    if (this.deps.mode === 'off' || !EXPORT_TOKEN_FORMAT.test(token)) return null;
    const hash = hashExportToken(token);
    const playlist = await this.deps.playlists.findByExportTokenHash(hash);
    if (!playlist) return null;
    return { contentType: this.deps.formatter.contentType, chunks: () => this.generate(playlist.id, { kind: 'export', id: hash }, origin) };
  }

  private async *generate(playlistId: string, grant: MediaGrant, origin: string): AsyncGenerator<string> {
    const { entries, secrets, formatter, media, logger } = this.deps;
    const proxied = this.deps.mode === 'proxied';
    const expiresAt = media.newStreamExpiry('export');
    yield formatter.header();
    for await (const rows of entries.exportBatches(playlistId, BATCH)) {
      let text = '';
      for (const row of rows) {
        try {
          const locator = secrets.openLocator(row.locator);
          if (!locator) continue;
          text += formatter.channel(
            proxied
              ? {
                  name: row.name,
                  number: row.number,
                  logo: row.logo && /^https?:\/\//i.test(row.logo) ? origin + media.imageProxyPath(row.logo) : null,
                  tvgId: row.tvgId,
                  groupName: row.groupName,
                  url: origin + media.streamProxyPath(locator.url, locator.headers, expiresAt, grant),
                  headers: {},
                  catchup: null,
                }
              : { name: row.name, number: row.number, logo: row.logo, tvgId: row.tvgId, groupName: row.groupName, url: locator.url, headers: locator.headers, catchup: row.catchup },
          );
        } catch (error) {
          // One unreadable stream (e.g. a key rotation gap) must not cost the user the whole playlist.
          logger.warn({ err: error, playlistId }, 'Skipped a channel whose stream could not be read');
        }
      }
      if (text) yield text;
    }
  }
}
