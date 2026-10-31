import { SourceFetchError, type AccountVerifier, type CatalogProvider, type FetchContext } from '../../application/ports/catalog-provider.js';
import type { SeriesDetails, SeriesDetailsSource } from '../../application/ports/series-details-source.js';
import type { CatalogBuild } from '../../domain/catalog/model.js';
import type { SourceCredential } from '../../domain/sources/source.js';
import { xtreamApiUrl, xtreamXmltvUrl, type XtreamAccount } from '../../domain/sources/xtream.js';
import type { UpstreamClient } from '../http/upstream-client.js';
import { toSourceFetchError } from './m3u-provider.js';
import { readSeriesDetails, readUserInfo, XtreamCatalogBuilder, type XtreamUserInfo } from './xtream-catalog.js';

export interface XtreamLimits {
  /** Cap of the live list response, after decompression (the VOD and series lists get twice that). */
  maxBytes: number;
  /** Cap of live + movies + series together. */
  maxEntries: number;
}

const AUTH_MAX_BYTES = 256 * 1024;
const CATEGORIES_MAX_BYTES = 4 * 1024 * 1024;
const SERIES_INFO_MAX_BYTES = 8 * 1024 * 1024;
const MAX_EPISODES_PER_SERIES = 5_000;
const CALL_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 20_000;

/**
 * Xtream Codes API (`player_api.php`) adapter: authenticates, reads the account state and the
 * live / VOD / series listings in one sync, and series episodes on demand (`get_series_info`
 * per series would be thousands of calls per sync — they are fetched when a series is opened).
 *
 * The three big lists are downloaded and converted one after another, each raw list released
 * before the next one is fetched, so peak memory is one list rather than three.
 *
 * Credentials travel in the query string, as the protocol demands; error messages and logs only
 * ever mention the host.
 */
export class XtreamProvider implements CatalogProvider, SeriesDetailsSource, AccountVerifier {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly limits: XtreamLimits,
  ) {}

  async fetchCatalog(credential: SourceCredential, context: FetchContext): Promise<CatalogBuild> {
    const account = accountOf(credential);

    await context.onStage('connecting');
    const user = await this.authenticate(account, context.signal);

    await context.onStage('parsing');
    const builder = new XtreamCatalogBuilder(user, { maxEntries: this.limits.maxEntries, epgUrl: xtreamXmltvUrl(account) });
    const signal = context.signal;
    builder.addLive(await this.categories(account, 'get_live_categories', signal), await this.call(account, { action: 'get_live_streams' }, this.limits.maxBytes, signal));
    builder.addMovies(await this.categories(account, 'get_vod_categories', signal), await this.optional(builder, account, 'get_vod_streams', 'Movies', signal));
    builder.addSeries(await this.categories(account, 'get_series_categories', signal), await this.optional(builder, account, 'get_series', 'Series', signal));
    return builder.build();
  }

  async verifyAccount(credential: SourceCredential, signal: AbortSignal): Promise<void> {
    await this.authenticate(accountOf(credential), AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]));
  }

  async fetchSeriesDetails(credential: SourceCredential, series: { key: string; xtreamId: number }, signal: AbortSignal): Promise<SeriesDetails> {
    const account = accountOf(credential);
    const payload = await this.call(account, { action: 'get_series_info', series_id: String(series.xtreamId) }, SERIES_INFO_MAX_BYTES, signal);
    return readSeriesDetails(payload, series.key, MAX_EPISODES_PER_SERIES);
  }

  private async authenticate(account: XtreamAccount, signal: AbortSignal): Promise<XtreamUserInfo> {
    const user = readUserInfo(await this.call(account, {}, AUTH_MAX_BYTES, signal));
    if (!user) throw new SourceFetchError('auth_failed', 'The provider rejected the username or password. Check them or your subscription.');
    return user;
  }

  private categories(account: XtreamAccount, action: string, signal: AbortSignal): Promise<unknown> {
    return this.call(account, { action }, CATEGORIES_MAX_BYTES, signal);
  }

  /**
   * VOD / series lists. Live-only accounts: some panels answer these actions with HTTP errors
   * instead of `[]` — credentials were already verified, so the list counts as empty. A list
   * over the size cap is skipped with a warning (live TV still syncs). Aborts and rejected
   * credentials still fail the sync.
   */
  private async optional(builder: XtreamCatalogBuilder, account: XtreamAccount, action: string, label: string, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.call(account, { action }, this.limits.maxBytes * 2, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof SourceFetchError)) throw error;
      if (error.problem === 'too_large') {
        builder.warn(`${action}_too_large`, `${label} list is larger than the allowed limit and was not imported.`);
        return [];
      }
      if (error.problem === 'unavailable' || error.problem === 'expired' || error.problem === 'invalid') return [];
      throw error;
    }
  }

  private async call(account: XtreamAccount, params: Record<string, string>, maxBytes: number, signal: AbortSignal): Promise<unknown> {
    const url = new URL(xtreamApiUrl(account, params));
    let bytes: Buffer;
    try {
      ({ bytes } = await this.upstream.fetchBytes(url, maxBytes, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        headers: { accept: 'application/json' },
      }));
    } catch (error) {
      throw toSourceFetchError(error, url);
    }
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
    // Some panels answer a bad login (or an unknown action) with an empty 200.
    if (!text) return params['action'] ? [] : null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SourceFetchError('invalid', `${url.host} did not answer like an Xtream Codes server. Check the server address.`);
    }
  }
}

function accountOf(credential: SourceCredential): XtreamAccount {
  if (credential.type !== 'xtream') throw new Error('XtreamProvider only reads Xtream sources');
  return { server: credential.server, username: credential.username, password: credential.password };
}
