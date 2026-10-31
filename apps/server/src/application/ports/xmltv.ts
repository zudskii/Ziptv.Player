import type { ProgrammeRecord } from './epg-repository.js';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon: string | null;
}

export type XmltvProgramme = ProgrammeRecord;

export interface XmltvHandlers {
  channel(channel: XmltvChannel): void;
  programme(programme: XmltvProgramme): void;
  /** Awaited between chunks: lets the consumer flush batches (natural backpressure). */
  drain(): Promise<void>;
}

/** Downloads and stream-parses an XMLTV guide (gzip or plain, any size up to the cap). */
export interface XmltvReader {
  read(url: string, signal: AbortSignal, handlers: XmltvHandlers): Promise<{ bytes: number }>;
}

export type GuideProblem = 'unavailable' | 'invalid' | 'too_large' | 'auth_failed' | 'blocked';

export class GuideFetchError extends Error {
  constructor(
    readonly problem: GuideProblem,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GuideFetchError';
  }
}
