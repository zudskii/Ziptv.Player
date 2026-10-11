import { Readable } from 'node:stream';

export interface PeekedStream {
  /** At least `minBytes` bytes (fewer only if the stream ended). */
  head: Buffer;
  /** The remainder of the source, starting right after `head`. */
  rest: AsyncIterator<Buffer>;
  ended: boolean;
}

/** Reads the first bytes of a stream without losing them, for content sniffing. */
export async function peekStream(stream: Readable, minBytes: number): Promise<PeekedStream> {
  const rest = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  while (size < minBytes) {
    const next = await rest.next();
    if (next.done) {
      ended = true;
      break;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    chunks.push(chunk);
    size += chunk.length;
  }
  return { head: Buffer.concat(chunks, size), rest, ended };
}

/** Re-assembles a peeked stream into a byte stream (backpressure preserved). */
export function rejoin(peeked: PeekedStream): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    if (peeked.head.length) yield peeked.head;
    if (peeked.ended) return;
    for (;;) {
      const next = await peeked.rest.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return Readable.from(generate(), { objectMode: false });
}

/** Collects the remainder of a peeked stream, failing once `maxBytes` is exceeded. */
export async function collect(peeked: PeekedStream, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [peeked.head];
  let size = peeked.head.length;
  if (!peeked.ended) {
    for (;;) {
      const next = await peeked.rest.next();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        await peeked.rest.return?.();
        return null;
      }
      chunks.push(next.value);
    }
  }
  return Buffer.concat(chunks, size);
}
