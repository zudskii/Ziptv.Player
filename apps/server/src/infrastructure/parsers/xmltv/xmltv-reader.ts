import { TextDecoder } from 'node:util';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream';

import { Parser } from 'htmlparser2';

import { GuideFetchError, type XmltvHandlers } from '../../../application/ports/xmltv.js';
import { episodeLabel, parseXmltvTime } from '../../../domain/epg/epg.js';
import { peekStream, rejoin } from '../../streams/peek.js';

const MAX_TEXT = 4_000;
const MAX_TITLE = 300;
const PROLOG_BYTES = 256;

interface ProgrammeDraft {
  channel: string;
  start: Date | null;
  stop: Date | null;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
  episodes: { system: string; value: string }[];
  rating: string | null;
}

/**
 * Streaming XMLTV reader (SAX): constant memory for 300 MB guides. Handles gzip by magic
 * bytes (servers often send `.xml.gz` as application/octet-stream), the encoding declared in
 * the prolog, and enforces a cap on the *decompressed* size (gzip bombs).
 */
export async function readXmltvStream(input: Readable, handlers: XmltvHandlers, options: { maxBytes: number; signal: AbortSignal }): Promise<{ bytes: number }> {
  const peeked = await peekStream(input, 2);
  let body: Readable = rejoin(peeked);
  if (peeked.head[0] === 0x1f && peeked.head[1] === 0x8b) {
    body = pipeline(body, createGunzip(), () => undefined);
  }

  let decoder: TextDecoder | null = null;
  let bytes = 0;
  let rootSeen = false;
  let failure: Error | null = null;

  const stack: string[] = [];
  let text = '';
  let channel: { id: string; names: string[]; icon: string | null } | null = null;
  let programme: ProgrammeDraft | null = null;
  let episodeSystem = '';

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (!rootSeen) {
          rootSeen = true;
          if (tag !== 'tv') failure = new GuideFetchError('invalid', tag === 'html' ? 'The guide URL returned a web page, not an XMLTV guide.' : `Not an XMLTV guide (root element <${tag}>).`);
        }
        stack.push(tag);
        text = '';
        switch (tag) {
          case 'channel':
            if (stack.length === 2) channel = { id: (attributes.id ?? '').trim(), names: [], icon: null };
            break;
          case 'programme':
            programme = {
              channel: (attributes.channel ?? '').trim(),
              start: parseXmltvTime(attributes.start),
              stop: parseXmltvTime(attributes.stop),
              title: null,
              subtitle: null,
              description: null,
              categories: [],
              icon: null,
              episodes: [],
              rating: null,
            };
            break;
          case 'icon': {
            const src = attributes.src?.trim();
            if (src && /^https?:\/\//i.test(src)) {
              if (programme && !programme.icon) programme.icon = src;
              else if (channel && !channel.icon) channel.icon = src;
            }
            break;
          }
          case 'episode-num':
            episodeSystem = (attributes.system ?? '').trim().toLowerCase();
            break;
          default:
            break;
        }
      },
      ontext(chunk) {
        if (text.length < MAX_TEXT) text += chunk;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        const value = text.trim();
        const parent = stack[stack.length - 2];
        if (channel && tag === 'display-name' && value && channel.names.length < 8) channel.names.push(value.slice(0, 200));
        if (programme) {
          switch (tag) {
            case 'title':
              if (!programme.title && value) programme.title = value.slice(0, MAX_TITLE);
              break;
            case 'sub-title':
              if (!programme.subtitle && value) programme.subtitle = value.slice(0, MAX_TITLE);
              break;
            case 'desc':
              if (!programme.description && value) programme.description = value.slice(0, MAX_TEXT);
              break;
            case 'category':
              if (value && programme.categories.length < 6 && !programme.categories.includes(value)) programme.categories.push(value.slice(0, 60));
              break;
            case 'episode-num':
              if (value) programme.episodes.push({ system: episodeSystem, value });
              break;
            case 'value':
              if (parent === 'rating' && value && !programme.rating) programme.rating = value.slice(0, 20);
              break;
            default:
              break;
          }
        }
        if (tag === 'channel' && channel && stack.length === 2) {
          if (channel.id) handlers.channel({ id: channel.id.slice(0, 200), names: channel.names, icon: channel.icon });
          channel = null;
        }
        if (tag === 'programme' && programme) {
          const draft: ProgrammeDraft = programme;
          programme = null;
          if (draft.channel && draft.title && draft.start && draft.stop && draft.stop.getTime() > draft.start.getTime()) {
            handlers.programme({
              channelId: draft.channel.slice(0, 200),
              start: draft.start,
              stop: draft.stop,
              title: draft.title,
              subtitle: draft.subtitle,
              description: draft.description,
              categories: draft.categories,
              icon: draft.icon,
              episode: episodeLabel(draft.episodes),
              rating: draft.rating,
            });
          }
        }
        stack.pop();
        text = '';
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );

  // The encoding is declared in the prolog: hold back the first bytes until it can be read.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const feed = (chunk: Buffer) => {
    if (!decoder) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < PROLOG_BYTES) return;
      chunk = Buffer.concat(pending, pendingBytes);
      pending = [];
      decoder = new TextDecoder(detectEncoding(chunk), { fatal: false });
    }
    parser.write(clean(decoder.decode(chunk, { stream: true })));
  };

  for await (const raw of body as AsyncIterable<Buffer>) {
    options.signal.throwIfAborted();
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > options.maxBytes) {
      body.destroy();
      throw new GuideFetchError('too_large', `The guide is larger than ${Math.round(options.maxBytes / 1024 / 1024)} MB.`);
    }
    feed(chunk);
    if (failure) {
      body.destroy();
      throw failure;
    }
    await handlers.drain();
  }
  if (!decoder && pendingBytes > 0) {
    const head = Buffer.concat(pending, pendingBytes);
    decoder = new TextDecoder(detectEncoding(head), { fatal: false });
    parser.write(clean(decoder.decode(head, { stream: true })));
  }
  if (decoder) parser.write(clean((decoder as TextDecoder).decode()));
  parser.end();
  if (failure) throw failure;
  if (!rootSeen) throw new GuideFetchError('invalid', 'The guide URL returned an empty response.');
  await handlers.drain();
  return { bytes };
}

/** Encoding from the XML prolog (`<?xml … encoding="windows-1251"?>`), default UTF-8. */
function detectEncoding(firstChunk: Buffer): string {
  if (firstChunk[0] === 0xef && firstChunk[1] === 0xbb && firstChunk[2] === 0xbf) return 'utf-8';
  const head = firstChunk.subarray(0, PROLOG_BYTES).toString('latin1');
  const label = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (!label) return 'utf-8';
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/**
 * C0 control characters other than tab/newline/CR are invalid in XML and PostgreSQL rejects NUL in
 * text columns: one stray byte must not fail the whole guide.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function clean(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}
