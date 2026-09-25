import type { Readable } from 'node:stream';

const ignore = (): void => undefined;

/**
 * Destroys a stream without risking an unhandled 'error' event.
 *
 * undici emits `RequestAbortedError` when a response body is destroyed early; without a
 * listener that crashes the process — e.g. when a probe stops reading an endless live
 * MPEG-TS stream after the first kilobyte.
 */
export function destroyQuietly(stream: Readable | null | undefined): void {
  if (!stream || stream.destroyed) return;
  stream.on('error', ignore);
  stream.destroy();
}
