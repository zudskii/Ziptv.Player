import { useEffect } from 'react';

import { readRawStorage } from '../../lib/storage';
import { useProfileStore } from '../profiles/profile-store';
import { useSources } from '../sources/api';
import { importLocalState } from '../user-state/api';
import { queryClient } from '../../lib/query-client';
import { useLibraryStore } from './library-store';

const IMPORTED = 'ziptv:library-imported';
let running = false;

/**
 * One-time move of this browser's favourites / recent channels (kept locally by earlier
 * versions) into the default profile on the server. Recents stay local as the quick "Recent"
 * filter; favourites are dropped locally once they are on the server.
 */
export function useImportLocalLibrary(): void {
  const sources = useSources().data;
  const profileId = useProfileStore((state) => state.profileId);
  useEffect(() => {
    if (!sources || sources.length === 0 || profileId !== null || running) return;
    if (readRawStorage(IMPORTED) === '1') return;
    const { favorites, recents } = useLibraryStore.getState();
    const hasData = Object.values(favorites).some((keys) => keys.length > 0) || Object.values(recents).some((keys) => keys.length > 0);
    const done = () => {
      try {
        localStorage.setItem(IMPORTED, '1');
      } catch {
        /* storage unavailable */
      }
    };
    if (!hasData) return done();
    running = true;
    void importLocalState({ favorites, recents })
      .then(() => {
        useLibraryStore.setState({ favorites: {} });
        done();
        void queryClient.invalidateQueries();
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, [sources, profileId]);
}
