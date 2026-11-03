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

/** sessionStorage that never throws: kept for this tab only (gone when the tab closes). */
const safeSessionStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.sessionStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      window.sessionStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: (name) => {
    try {
      window.sessionStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const tabStorage = createJSONStorage(() => safeSessionStorage);

export function readRawStorage(key: string): string | null {
  return safeLocalStorage.getItem(key) as string | null;
}

export function removeRawStorage(key: string): void {
  void safeLocalStorage.removeItem(key);
}
