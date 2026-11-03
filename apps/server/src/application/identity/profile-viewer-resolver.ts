import type { ParentalService } from './parental.service.js';
import type { AuthUser } from './session.service.js';
import type { ViewerResolver } from './viewer-resolver.js';
import type { Viewer } from './viewer.js';

/**
 * Viewer of a request from the account's profiles and parental controls: `X-Profile-Id` selects
 * one (else the device's kids profile, else the default profile); its restrictions and the
 * `X-Unlock-Token` decide what it sees. An unknown profile id is a 404 (the client drops its
 * stored selection) — never a silent fallback to another profile's data — and a profile the
 * device may not open without the PIN is a 403 PIN_REQUIRED.
 */
export class ProfileViewerResolver implements ViewerResolver {
  constructor(private readonly parental: Pick<ParentalService, 'viewerFor'>) {}

  resolve(user: AuthUser, input: { profileId?: string | undefined; unlockToken?: string | undefined }): Promise<Viewer> {
    return this.parental.viewerFor(user, input);
  }
}
