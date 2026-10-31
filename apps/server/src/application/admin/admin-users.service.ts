import type { AdminUserDetailDto, AdminUserPageDto, AdminUserSummaryDto } from '@ziptv/contracts';

import { newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { AdminQueries, AdminUnitOfWork, AdminUserRecord } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import { OUTBOX_JOB } from '../outbox/outbox-dispatcher.js';
import type { SessionRepository } from '../ports/session-repository.js';
import type { JobKicker } from '../sources/hooks.js';
import { actorOf, type AdminContext, type StaffPrincipal } from './principal.js';

export const USER_SESSIONS_REVOKED = 'user.sessions_revoked';

function toSummary(user: AdminUserRecord): AdminUserSummaryDto {
  return {
    id: user.id,
    email: user.email,
    isGuest: user.email === null,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
    sources: user.sources,
    sessions: user.sessions,
  };
}

/** Subscriber lookup and support actions. Reads are plain; every action is audited. */
export class AdminUsersService {
  constructor(
    private readonly deps: {
      queries: AdminQueries;
      sessions: SessionRepository;
      uow: AdminUnitOfWork;
      clock: Clock;
      /** Stream links of the signed-out sessions stop at once (media grants). */
      onSessionsRevoked: (sessionIds: string[]) => void;
      /** Wakes the outbox worker so the side effects go out now, not at the next poll. */
      jobs?: JobKicker;
    },
  ) {}

  async search(query: { text?: string | undefined; offset: number; limit: number }): Promise<AdminUserPageDto> {
    const page = await this.deps.queries.searchUsers(query);
    return { items: page.items.map(toSummary), total: page.total };
  }

  async get(id: string): Promise<AdminUserDetailDto> {
    const user = await this.deps.queries.findUser(id);
    if (!user) throw AppError.notFound('User');
    const [sessions, sources] = await Promise.all([this.deps.sessions.listForUser(id), this.deps.queries.userSources(id)]);
    return {
      ...toSummary(user),
      sessionsList: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt?.toISOString() ?? null,
        userAgent: session.userAgent,
      })),
      sourcesList: sources.map((source) => ({ ...source, lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null })),
    };
  }

  /** Signs the user out on every device (support action, e.g. a shared/stolen account). */
  async revokeSessions(actor: StaffPrincipal, userId: string, context: AdminContext): Promise<{ revoked: number }> {
    const user = await this.deps.queries.findUser(userId);
    if (!user) throw AppError.notFound('User');
    const ids = (await this.deps.sessions.listForUser(userId)).map((session) => session.id);
    const now = this.deps.clock.now();
    await this.deps.uow.run(async (tx) => {
      await tx.sessions.deleteForUser(userId);
      await tx.audit.append({ ...actorOf(actor, context), occurredAt: now, action: USER_SESSIONS_REVOKED, targetType: 'user', targetId: userId, beforeHash: null, afterHash: null, details: { sessions: ids.length } });
      await tx.outbox.enqueue({ id: newEntityId(), topic: USER_SESSIONS_REVOKED, payload: { userId, sessions: ids.length }, now });
    });
    this.deps.onSessionsRevoked(ids);
    this.deps.jobs?.kick(OUTBOX_JOB);
    return { revoked: ids.length };
  }
}
