/** Deterministic, readable background colour per name (initials tiles, profile avatars). */
export function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 34%)`;
}
