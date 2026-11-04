import { useSessionStore } from '../session/session';
import { authApi } from './api';

/**
 * Ends this device's session. The server call is best effort (offline, or the session already
 * expired: either way the device must forget the account), then everything cached for it is dropped
 * (queries, active profile, parental unlocks) and every protected screen — in every open tab —
 * goes to the sign-in page. No guest is started behind the person's back.
 */
export async function signOut(): Promise<void> {
  try {
    await authApi.logout();
  } catch {
    /* the token is forgotten locally regardless */
  }
  useSessionStore.getState().clear();
}
