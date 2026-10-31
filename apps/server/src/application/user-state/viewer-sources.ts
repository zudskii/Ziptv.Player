import type { Viewer } from '../identity/viewer.js';
import type { SourceRevisionRef } from '../ports/catalog-repository.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';

/** The viewer's sources that have a catalog, by id, plus their pinned revisions. */
export async function usableSources(sources: SourceRepository, viewer: Viewer): Promise<{ byId: Map<string, SourceRecord>; refs: SourceRevisionRef[] }> {
  const usable = (await sources.listByOwner(viewer.userId)).filter((source) => source.revision > 0);
  return {
    byId: new Map(usable.map((source) => [source.id, source])),
    refs: usable.map((source) => ({ sourceId: source.id, revision: source.revision })),
  };
}

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
