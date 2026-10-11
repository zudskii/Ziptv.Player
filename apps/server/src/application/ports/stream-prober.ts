import type { StreamHeaders, StreamKind } from '../../domain/catalog/model.js';

/** Detects the container of URLs without a telling extension (Xtream `…/user/pass/1234`). */
export interface StreamProber {
  probe(url: string, headers: StreamHeaders): Promise<StreamKind>;
}
