import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * localStorage that never throws (private mode, disabled storage, quota exceeded):
 * the app keeps working, preferences are just not remembered.
 */
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const persistentStorage = createJSONStorage(() => safeLocalStorage);

export function readRawStorage(key: string): string | null {
  return safeLocalStorage.getItem(key) as string | null;
}

export function removeRawStorage(key: string): void {
  void safeLocalStorage.removeItem(key);
}
