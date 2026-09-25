import type { RawEntry } from './types.js';

const PLS_LINE = /^(file|title|length)(\d+)\s*=\s*(.*)$/i;

/** `[playlist]` / `FileN=` / `TitleN=` / `LengthN=` (Shoutcast/Winamp PLS). */
export function scanPls(text: string): RawEntry[] {
  const byIndex = new Map<string, { line: number; uri?: string; title?: string; duration?: number }>();

  text.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const match = PLS_LINE.exec(rawLine.trim());
    if (!match) return;
    const [, field = '', number = '', value = ''] = match;
    const entry = byIndex.get(number) ?? { line: index + 1 };
    byIndex.set(number, entry);

    switch (field.toLowerCase()) {
      case 'file':
        entry.uri = value.trim();
        entry.line = index + 1;
        break;
      case 'title':
        entry.title = value.trim();
        break;
      case 'length': {
        const duration = Number(value);
        entry.duration = Number.isFinite(duration) ? duration : -1;
        break;
      }
    }
  });

  const entries: RawEntry[] = [];
  const ordered = [...byIndex.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, entry]) => entry);
  for (const entry of ordered) {
    if (!entry.uri) continue;
    entries.push({
      line: entry.line,
      uri: entry.uri,
      title: entry.title ?? '',
      duration: entry.duration ?? -1,
      attributes: {},
      extGroup: null,
      extImage: null,
      headers: {},
      drm: false,
      kindHint: null,
    });
  }
  return entries;
}
