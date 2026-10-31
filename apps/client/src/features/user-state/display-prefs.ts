import { create } from 'zustand';

/** Display settings read by many components (mirrored from the profile's settings). */
export const useDisplayPrefs = create<{ showProgress: boolean; use24h: boolean }>(() => ({ showProgress: true, use24h: true }));
