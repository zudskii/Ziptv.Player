import { useSyncExternalStore } from 'react';

interface ClockStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

const stores = new Map<number, ClockStore>();

/**
 * One shared ticking clock per resolution (e.g. 30 s for programme progress bars), so a list of
 * 500 cards re-renders on one timer instead of 500. The store objects are stable per resolution
 * — re-creating subscribe/getSnapshot on every render makes useSyncExternalStore resubscribe
 * forever (React #185).
 */
function clockStore(resolutionMs: number): ClockStore {
  let store = stores.get(resolutionMs);
  if (store) return store;
  const listeners = new Set<() => void>();
  let now = quantize(Date.now(), resolutionMs);
  let timer: ReturnType<typeof setInterval> | null = null;
  store = {
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        now = quantize(Date.now(), resolutionMs);
        timer = setInterval(() => {
          const next = quantize(Date.now(), resolutionMs);
          if (next === now) return;
          now = next;
          listeners.forEach((notify) => notify());
        }, Math.min(resolutionMs, 1_000));
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => now,
  };
  stores.set(resolutionMs, store);
  return store;
}

function quantize(value: number, resolutionMs: number): number {
  return value - (value % resolutionMs);
}

/** Current time (ms), updated every `resolutionMs`. */
export function useNow(resolutionMs = 30_000): number {
  const store = clockStore(resolutionMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
