import { AppError } from '../errors.js';
import type { ProfileService } from './profile.service.js';
import type { AuthUser } from './session.service.js';
import type { ViewerResolver } from './viewer-resolver.js';
import type { Viewer } from './viewer.js';

/**
 * Viewer of a request from the account's profiles: `X-Profile-Id` selects one, otherwise the
 * default profile. Kids profiles never see adult content. An unknown profile id is a 404 (the
 * client drops its stored selection) — never a silent fallback to another profile's data.
 */
export class ProfileViewerResolver implements ViewerResolver {
  constructor(private readonly profiles: Pick<ProfileService, 'records'>) {}

  async resolve(user: AuthUser, input: { profileId?: string | undefined; unlockToken?: string | undefined }): Promise<Viewer> {
    const profiles = await this.profiles.records(user.id);
    const profile = input.profileId ? profiles.find((item) => item.id === input.profileId) : profiles.find((item) => item.isDefault);
    if (!profile) throw new AppError('NOT_FOUND', 404, 'Profile not found.', { reason: 'profile' });
    const kids = profile.kind === 'kids';
    return {
      userId: user.id,
      sessionId: user.sessionId,
      profileId: profile.id,
      kids,
      hideAdult: kids,
      lockedGroups: new Set(),
      lockedChannels: new Set(),
      unlocked: false,
      restrictionsVersion: profile.kind,
    };
  }
}
