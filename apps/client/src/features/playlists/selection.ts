/**
 * Selection of rows by id plus what a drag moves: dragging a row that is part of the selection
 * takes the whole selection along; dragging an unselected row moves just that row.
 */
export function idsToDrag(draggedId: string, selected: ReadonlySet<string>): string[] {
  return selected.has(draggedId) ? [...selected] : [draggedId];
}

/** Ids of rows between two indexes (inclusive, either order) that are already loaded. */
export function idsInRange(from: number, to: number, idAt: (index: number) => string | undefined): string[] {
  const ids: string[] = [];
  for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
    const id = idAt(index);
    if (id) ids.push(id);
  }
  return ids;
}

export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The server accepts this many ids per request; longer selections go in several. */
export const MAX_IDS_PER_REQUEST = 5000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) chunks.push(items.slice(offset, offset + size));
  return chunks;
}
