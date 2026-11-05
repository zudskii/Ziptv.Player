import type { HelpSettingsDto } from '@ziptv/contracts';
import { useCallback, useMemo } from 'react';

import { useSettings, useUpdateSettings } from '../user-state/api';

/** Matches the server: tip ids are short slugs and at most this many are remembered. */
const MAX_SEEN = 50;

const EMPTY: HelpSettingsDto = { seen: [], checklistDismissed: false };

export interface Help {
  /** False until the profile's settings have loaded — nothing should pop up before then. */
  ready: boolean;
  seen: (id: string) => boolean;
  markSeen: (id: string) => void;
  checklistDismissed: boolean;
  dismissChecklist: () => void;
  /** Every tip, tour and the checklist show again. */
  reset: () => void;
}

/**
 * Which tips and tours this profile has already seen. Stored in the profile's settings (so a
 * family member on the same TV still gets their own tours) and saved optimistically.
 */
export function useHelp(): Help {
  const settings = useSettings();
  const update = useUpdateSettings();
  const help = settings.data?.help ?? EMPTY;
  const { mutate } = update;

  const seenSet = useMemo(() => new Set(help.seen), [help.seen]);
  const markSeen = useCallback(
    (id: string) => {
      if (seenSet.has(id)) return;
      // Oldest ids drop off first; at worst a long-forgotten tip shows once more.
      mutate({ help: { seen: [...help.seen, id].slice(-MAX_SEEN) } });
    },
    [help.seen, seenSet, mutate],
  );

  return {
    ready: settings.isSuccess,
    seen: (id) => seenSet.has(id),
    markSeen,
    checklistDismissed: help.checklistDismissed,
    dismissChecklist: () => mutate({ help: { checklistDismissed: true } }),
    reset: () => mutate({ help: { seen: [], checklistDismissed: false } }),
  };
}
