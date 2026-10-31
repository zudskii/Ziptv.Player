/** `list` with `item` moved one place up (-1) or down (+1); unchanged at the ends or when absent. */
export function moveItem<T>(list: readonly T[], item: T, direction: -1 | 1): T[] {
  const index = list.indexOf(item);
  const target = index + direction;
  const next = [...list];
  if (index === -1 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
