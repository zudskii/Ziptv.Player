import { useSessionStore } from '../session/session';
import { authApi } from './api';

/**
 * Ends this device's session. The server call is best effort (offline, or the session already
 * expired: either way the device must forget the account), then everything cached is dropped and
 * the next screen starts a fresh guest.
 */
export async function signOut(): Promise<void> {
  try {
    await authApi.logout();
  } catch {
    /* the token is forgotten locally regardless */
  }
  useSessionStore.getState().clear();
}
