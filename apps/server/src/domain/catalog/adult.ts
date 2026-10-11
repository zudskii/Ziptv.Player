/**
 * Adult-content detection from provider labels (group/category names and titles).
 * Used to hide such items for kids profiles and when "Hide adult content" is on.
 * Deliberately label-based: providers consistently put adult content in clearly named groups.
 */
const ADULT_PATTERN =
  /(?:^|[^\p{L}\p{N}])(?:xxx|adults?|adult\s*only|for\s+adults|18\s*\+|\+\s*18|porn\w*|erotic\w*|hustler|playboy|brazzers|redlight|private\s*tv|для\s+взрослых|эроти\w*|взросл\w*|ზრდასრულ\w*)(?:$|[^\p{L}\p{N}])/iu;

export function isAdultLabel(value: string | null | undefined): boolean {
  return !!value && ADULT_PATTERN.test(value);
}

export function isAdultEntry(entry: { name: string; groups: readonly string[] }, explicitFlag = false): boolean {
  return explicitFlag || entry.groups.some(isAdultLabel) || isAdultLabel(entry.name);
}
