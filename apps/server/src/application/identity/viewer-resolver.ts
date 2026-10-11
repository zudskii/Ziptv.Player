import type { AuthUser } from './session.service.js';
import { unrestrictedViewer, type Viewer } from './viewer.js';

/** Builds the Viewer of a request (profile selection + parental restrictions). */
export interface ViewerResolver {
  resolve(user: AuthUser, input: { profileId?: string | undefined; unlockToken?: string | undefined }): Promise<Viewer>;
}

/** Single-profile resolver (no profiles/parental controls configured). */
export const accountViewerResolver: ViewerResolver = {
  resolve: async (user) => unrestrictedViewer(user.id),
};
