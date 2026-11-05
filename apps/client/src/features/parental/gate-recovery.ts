import { configureGateRecovery } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { useProfileStore } from '../profiles/profile-store';
import { askPin } from './pin-prompt';
import { apiRequest } from '../../lib/api-client';
import { t } from '../../i18n';

/**
 * Recovers from the server's profile gate: a device held in a kids profile goes back to it; a
 * protected profile not opened here asks for the PIN once (cancelling falls back to the default).
 */
export function installGateRecovery(): void {
  let asking: Promise<boolean> | null = null;
  configureGateRecovery(async (gate) => {
    const store = useProfileStore.getState();
    if (gate.reason === 'kids_lock') {
      store.select(gate.profileId);
      void queryClient.invalidateQueries({ queryKey: ['profiles'] });
      return true;
    }
    // Several requests fail at once: one dialog for all of them.
    asking ??= askPin({
      title: t('parental.enterPin'),
      description: t('parental.profileLocked'),
      verify: async (pin) => void (await apiRequest(`/api/v1/profiles/${gate.profileId}/access`, { method: 'POST', body: { pin }, gateRecovery: false, })),
    }).finally(() => {
      asking = null;
    });
    const opened = await asking;
    if (!opened && store.profileId === gate.profileId) store.select(null);
    return opened;
  });
}
