/** Drag and drop of playlist entries (desktop). Touch devices use the "Move to…" actions instead. */
export const DRAG_TYPE = 'application/x-ziptv-entries';

interface DragEventLike {
  dataTransfer: DataTransfer | null;
}

export function writeDrag(event: DragEventLike, ids: readonly string[]): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
  event.dataTransfer.effectAllowed = 'move';
}

/** During dragover the payload is hidden by the browser, but its type is visible. */
export function hasDrag(event: DragEventLike): boolean {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes(DRAG_TYPE));
}

/** Entry ids carried by a drop, or null when the drop is something else (a file, a link…). */
export function readDrag(event: DragEventLike): string[] | null {
  const raw = event.dataTransfer?.getData(DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') && parsed.length > 0 ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}
