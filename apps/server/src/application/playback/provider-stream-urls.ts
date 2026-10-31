import type { StreamKind } from '../../domain/catalog/model.js';
import { xtreamStreamUrl, type XtreamStreamType } from '../../domain/sources/xtream.js';
import { AppError } from '../errors.js';
import type { SourceRecord } from '../ports/source-repository.js';
import type { SourceSecrets } from '../sources/secrets.js';
import type { StreamTarget, StreamUrlResolver } from './playback-ports.js';

const STREAM_TYPES: Record<'live' | 'movie' | 'episode', XtreamStreamType> = { live: 'live', movie: 'movie', episode: 'series' };

/**
 * Stream addresses of Xtream items: built at play time from the (encrypted) account and the
 * item id, never stored. Live channels use the format chosen at sync time (`hls` → `.m3u8`,
 * otherwise MPEG-TS); movies and episodes their container extension.
 */
export class ProviderStreamUrls implements StreamUrlResolver {
  constructor(private readonly secrets: SourceSecrets) {}

  async provider(source: SourceRecord, type: 'live' | 'movie' | 'episode', ref: { id: number; ext?: string }, kind: StreamKind): Promise<StreamTarget> {
    const credential = this.secrets.openCredential(source.credential);
    if (credential.type !== 'xtream') {
      throw new AppError('UNPLAYABLE', 422, 'This item has no stream address.', { reason: 'unsupported_format' });
    }
    const extension = type === 'live' ? (kind === 'hls' ? 'm3u8' : 'ts') : (ref.ext ?? 'mp4');
    const url = xtreamStreamUrl(credential, STREAM_TYPES[type], ref.id, extension);
    return { kind, unplayableReason: null, locator: { url, headers: {} } };
  }
}
