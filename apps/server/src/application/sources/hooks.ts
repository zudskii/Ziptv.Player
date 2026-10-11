import type { LiveChannelEntry } from '../../domain/catalog/model.js';
import type { SourceRecord } from '../ports/source-repository.js';

/**
 * EPG integration points of the source sync (implemented by the EPG module).
 * Kept as an interface so the source pipeline does not depend on how guides work.
 */
export interface CatalogEpgLinker {
  /** Links the channels of a revision being built to the user's existing guides (in memory). */
  linkBuild(source: SourceRecord, live: LiveChannelEntry[]): Promise<void>;
  /** After the revision is live: create/attach guides for announced URLs, sync what is missing. */
  afterCommit(source: SourceRecord, epgUrls: string[]): Promise<void>;
  /** Number of guides attached to each source (for the source list). */
  guideCounts(ownerId: string): Promise<Map<string, number>>;
}

export const noopEpgLinker: CatalogEpgLinker = {
  linkBuild: async () => undefined,
  afterCommit: async () => undefined,
  guideCounts: async () => new Map(),
};

/** Modules that keep data about a source (guides, My List, progress) clean up through this. */
export interface SourceRemovalListener {
  onSourceRemoved(ownerId: string, sourceId: string): Promise<void>;
}

/** Wakes the background job runner so a queued sync starts now instead of at the next tick. */
export interface JobKicker {
  kick(job: string): void;
}
