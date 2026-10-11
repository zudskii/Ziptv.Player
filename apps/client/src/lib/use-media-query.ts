import { useCallback, useSyncExternalStore } from 'react';

/** `useMediaQuery('(min-width: 1024px)')` — callbacks memoised per query (stable subscription). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
