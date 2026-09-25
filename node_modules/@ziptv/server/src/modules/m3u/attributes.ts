export interface ExtinfLine {
  duration: number;
  attributes: Record<string, string>;
  title: string;
}

const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_VALUE = 4096;
const VALID_KEY = /^[a-z0-9][a-z0-9_:-]{0,63}$/;

/**
 * Parses the body of an `#EXTINF:` line: `<duration> key="value" key2=value2,<title>`.
 *
 * Quote-aware scanner — the title starts at the first comma that is NOT inside a quoted
 * attribute value, so `tvg-name="News, Weather"` or logo URLs containing commas no longer
 * leak into the channel name. Everything after that comma (commas included) is the title.
 */
export function parseExtinf(body: string): ExtinfLine {
  const scanner = new Scanner(body);
  scanner.skipWhitespace();
  const duration = scanner.readNumber();
  const { attributes, terminatedByComma } = readAttributes(scanner, true);

  let title = '';
  if (terminatedByComma) {
    title = scanner.rest();
  } else if (Object.keys(attributes).length === 0 && duration === null) {
    // Non-standard `#EXTINF:Some title` (no duration, no comma).
    title = body;
  }

  return { duration: duration ?? -1, attributes, title: title.trim() };
}

/** Parses `key="value" key2=value2 ...` lists such as the `#EXTM3U` header attributes. */
export function parseAttributeList(body: string): Record<string, string> {
  return readAttributes(new Scanner(body), false).attributes;
}

function readAttributes(
  scanner: Scanner,
  stopAtComma: boolean,
): { attributes: Record<string, string>; terminatedByComma: boolean } {
  const attributes: Record<string, string> = {};
  let count = 0;

  while (!scanner.done()) {
    scanner.skipWhitespace();
    if (scanner.done()) break;

    if (scanner.peek() === ',') {
      scanner.advance();
      if (stopAtComma) return { attributes, terminatedByComma: true };
      continue;
    }

    const key = scanner.readUntil((ch) => ch === '=' || ch === ',' || isWhitespace(ch)).toLowerCase();
    if (scanner.peek() !== '=') {
      // Bare token without a value (junk such as `-1 x ,Title`) — ignore it.
      if (!key) scanner.advance();
      continue;
    }
    scanner.advance(); // '='

    const value = readValue(scanner, stopAtComma);
    // Keys are restricted to the charset real attributes use; this also keeps them safe as
    // document field names (no '.', no leading '$').
    if (VALID_KEY.test(key) && count < MAX_ATTRIBUTES && !(key in attributes)) {
      attributes[key] = value.slice(0, MAX_ATTRIBUTE_VALUE).trim();
      count++;
    }
  }

  return { attributes, terminatedByComma: false };
}

function readValue(scanner: Scanner, stopAtComma: boolean): string {
  const quote = scanner.peek();
  if (quote === '"' || quote === "'") {
    const closing = scanner.indexOf(quote, 1);
    if (closing !== -1) {
      scanner.advance();
      const value = scanner.take(closing - 1);
      scanner.advance(); // closing quote
      return value;
    }
    // Unterminated quote: take the value up to the next separator instead of eating the title.
    scanner.advance();
  }
  return scanner.readUntil((ch) => isWhitespace(ch) || (stopAtComma && ch === ','));
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\u00a0';
}

class Scanner {
  private index = 0;

  constructor(private readonly input: string) {}

  done(): boolean {
    return this.index >= this.input.length;
  }

  peek(): string {
    return this.input[this.index] ?? '';
  }

  advance(): void {
    this.index++;
  }

  /** Index of `ch` relative to the current position, or -1. */
  indexOf(ch: string, fromOffset: number): number {
    const found = this.input.indexOf(ch, this.index + fromOffset);
    return found === -1 ? -1 : found - this.index;
  }

  take(length: number): string {
    const value = this.input.slice(this.index, this.index + length);
    this.index += length;
    return value;
  }

  rest(): string {
    const value = this.input.slice(this.index);
    this.index = this.input.length;
    return value;
  }

  skipWhitespace(): void {
    while (!this.done() && isWhitespace(this.peek())) this.index++;
  }

  readUntil(stop: (ch: string) => boolean): string {
    const start = this.index;
    while (!this.done() && !stop(this.peek())) this.index++;
    return this.input.slice(start, this.index);
  }

  /** Reads an optional signed decimal (the EXTINF duration). */
  readNumber(): number | null {
    const match = /^[-+]?\d+(?:\.\d+)?/.exec(this.input.slice(this.index));
    if (!match) return null;
    this.index += match[0].length;
    return Number(match[0]);
  }
}
