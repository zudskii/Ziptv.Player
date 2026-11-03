import type { FeedProber, MediaDecoder, ProbeObservation, ProbeStep, ProbeStepKind } from '../../application/ports/health.js';
import type { StreamHeaders, StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import { isSuccess, type ProbeOutcome } from '../../domain/health/feed-health.js';
import { cheapestVariant, isMasterPlaylistText, outcomeOfStatus, parseMediaPlaylist, parseVariants } from '../../domain/health/hls-manifest.js';
import { decodeContent, firstHeader, UpstreamError, type UpstreamClient } from '../http/upstream-client.js';
import { sniffStreamKind } from '../media/stream-sniffer.js';
import { destroyQuietly } from '../streams/destroy.js';

export interface FeedProberOptions {
  /** A first byte later than this marks a working stream as `degraded`. */
  slowTtfbMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  maxManifestBytes: number;
  /** How much of a segment / progressive stream is downloaded (enough to decode a sample). */
  sampleBytes: number;
}

export const DEFAULT_PROBER_OPTIONS: FeedProberOptions = { slowTtfbMs: 2_000, timeoutMs: 10_000, maxManifestBytes: 512 * 1024, sampleBytes: 1024 * 1024 };

const SEVERITY: Record<ProbeOutcome, number> = { ok: 0, degraded: 1, stalled: 2, invalid_media: 3, http_error: 4, unreachable: 5, geo_blocked: 6, not_entitled: 7 };

interface Fetched {
  step: ProbeStep;
  body: Buffer | null;
  url: URL | null;
}

/**
 * Probes a feed the way a player would, but as cheaply as possible:
 *   HLS: playlist (→ cheapest variant) → newest segment (first `sampleBytes`) [→ decode]
 *   TS / progressive: the first `sampleBytes` of the stream [→ decode]
 * All requests go through the guarded upstream client (SSRF policy, timeouts). "HTTP 200" is not
 * enough: the playlist must parse, the segment must contain media, and the caller checks that
 * the live window moves between probes.
 */
export class HttpFeedProber implements FeedProber {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly decoder: MediaDecoder | null,
    private readonly options: FeedProberOptions = DEFAULT_PROBER_OPTIONS,
  ) {}

  async probe(locator: StreamLocator, kind: StreamKind, options: { decode: boolean; signal: AbortSignal }): Promise<ProbeObservation> {
    try {
      return await this.run(locator, kind, options);
    } catch (error) {
      // Anything unexpected (a malformed URI in a playlist, …) is a finding about the stream, not a
      // reason to leave the probe unfinished.
      return { outcome: 'invalid_media', steps: [failure('manifest', 'invalid_media', describe(error))], playlist: null, decoded: false };
    }
  }

  private async run(locator: StreamLocator, kind: StreamKind, options: { decode: boolean; signal: AbortSignal }): Promise<ProbeObservation> {
    const steps: ProbeStep[] = [];
    let playlist: ProbeObservation['playlist'] = null;
    let sample: Buffer | null = null;

    if (kind === 'hls' || /\.m3u8?(\?|$)/i.test(locator.url)) {
      let manifest = await this.fetch('manifest', locator.url, locator.headers, this.options.maxManifestBytes, options.signal, true);
      steps.push(manifest.step);
      if (manifest.body && manifest.url && isMasterPlaylistText(manifest.body.toString('utf8'))) {
        const variant = cheapestVariant(parseVariants(manifest.body.toString('utf8')));
        if (!variant) {
          steps.push(failure('manifest', 'invalid_media', 'Master playlist without variants'));
        } else {
          manifest = await this.fetch('manifest', new URL(variant.uri, manifest.url).toString(), locator.headers, this.options.maxManifestBytes, options.signal, true);
          steps.push(manifest.step);
        }
      }
      if (manifest.body && manifest.url && isSuccess(manifest.step.outcome)) {
        const media = parseMediaPlaylist(manifest.body.toString('utf8'));
        const last = media?.segments.at(-1);
        if (!media || !last) {
          steps.push(failure('manifest', 'invalid_media', 'Not a media playlist (or no segments)'));
        } else {
          playlist = media.endList ? null : { mediaSequence: media.mediaSequence, lastSegment: last, targetDurationSecs: media.targetDurationSecs };
          const segment = await this.fetch('segment', new URL(last, manifest.url).toString(), locator.headers, this.options.sampleBytes, options.signal, false);
          if (segment.body && isSuccess(segment.step.outcome) && segment.body.length === 0) {
            segment.step.outcome = 'invalid_media';
            segment.step.error = 'Empty segment';
          }
          steps.push(segment.step);
          sample = segment.body;
          // fMP4 segments only decode together with their init section.
          if (options.decode && media.map && sample && isSuccess(segment.step.outcome)) {
            const init = await this.fetch('segment', new URL(media.map, manifest.url).toString(), locator.headers, this.options.sampleBytes, options.signal, true);
            steps.push(init.step);
            sample = init.body ? Buffer.concat([init.body, sample]) : null;
          }
        }
      }
    } else {
      const stream = await this.fetch('stream', locator.url, locator.headers, this.options.sampleBytes, options.signal, false);
      if (stream.body && isSuccess(stream.step.outcome)) {
        const sniffed = sniffStreamKind(stream.body.subarray(0, 1024));
        if (sniffed === 'unknown' || sniffed === 'hls') {
          stream.step.outcome = 'invalid_media';
          stream.step.error = 'The response is not a media stream';
        }
      }
      steps.push(stream.step);
      sample = stream.body;
    }

    let decoded = false;
    if (options.decode && this.decoder && sample && sample.length > 0 && steps.every((step) => isSuccess(step.outcome))) {
      const started = Date.now();
      const result = await this.decoder.inspect(sample, options.signal);
      if (result) {
        decoded = true;
        steps.push({
          kind: 'decode',
          outcome: result.ok ? 'ok' : 'invalid_media',
          httpStatus: null,
          ttfbMs: null,
          durationMs: Date.now() - started,
          bytes: sample.length,
          error: result.ok ? null : (result.error ?? 'No decodable audio/video'),
        });
      }
    }

    const outcome = steps.reduce<ProbeOutcome>((worst, step) => (SEVERITY[step.outcome] > SEVERITY[worst] ? step.outcome : worst), 'ok');
    return { outcome, steps, playlist, decoded };
  }

  /** One timed request; `whole` = the full body (≤ max) is needed, else the first `max` bytes. */
  private async fetch(kind: ProbeStepKind, url: string, headers: StreamHeaders, max: number, parent: AbortSignal, whole: boolean): Promise<Fetched> {
    const started = Date.now();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.options.timeoutMs)]);
    let response;
    try {
      response = await this.upstream.request(url, { headers, signal, bodyTimeoutMs: this.options.timeoutMs });
    } catch (error) {
      return { step: failure(kind, 'unreachable', describe(error), Date.now() - started), body: null, url: null };
    }
    const ttfbMs = Date.now() - started;
    const body = decodeContent(response.body, firstHeader(response.headers['content-encoding']));
    try {
      const bytes = await readUpTo(body, response.status >= 400 ? 1024 : max, whole && response.status < 400);
      const durationMs = Date.now() - started;
      const statusOutcome = outcomeOfStatus(response.status, bytes?.toString('utf8') ?? '');
      if (statusOutcome) return { step: { kind, outcome: statusOutcome, httpStatus: response.status, ttfbMs, durationMs, bytes: null, error: `HTTP ${response.status}` }, body: null, url: response.url };
      if (bytes === null) return { step: { kind, outcome: 'invalid_media', httpStatus: response.status, ttfbMs, durationMs, bytes: null, error: `Larger than ${max} bytes` }, body: null, url: response.url };
      const outcome: ProbeOutcome = ttfbMs > this.options.slowTtfbMs ? 'degraded' : 'ok';
      return { step: { kind, outcome, httpStatus: response.status, ttfbMs, durationMs, bytes: bytes.length, error: null }, body: bytes, url: response.url };
    } catch (error) {
      return { step: failure(kind, 'unreachable', describe(error), Date.now() - started, response.status, ttfbMs), body: null, url: null };
    } finally {
      destroyQuietly(body);
      destroyQuietly(response.body);
    }
  }
}

/** The first `max` bytes; with `whole`, null when the body is larger than `max`. */
async function readUpTo(stream: AsyncIterable<Buffer> & NodeJS.ReadableStream, max: number, whole: boolean): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + buffer.length > max) {
      if (whole) return null;
      chunks.push(buffer.subarray(0, max - size));
      size = max;
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  return Buffer.concat(chunks, size);
}

function failure(kind: ProbeStepKind, outcome: ProbeOutcome, error: string, durationMs = 0, httpStatus: number | null = null, ttfbMs: number | null = null): ProbeStep {
  return { kind, outcome, httpStatus, ttfbMs, durationMs, bytes: null, error };
}

function describe(error: unknown): string {
  if (error instanceof UpstreamError) return `${error.kind}: ${error.message}`;
  if (error instanceof Error) return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message;
  return String(error);
}
