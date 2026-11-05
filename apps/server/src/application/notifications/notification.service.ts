import type { NotificationDto, NotificationListDto, NotificationType } from '@ziptv/contracts';

import { AppError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { NewNotification, NotificationRecord, NotificationRepository, NotificationScope } from '../ports/notification-repository.js';

const LIST_LIMIT = 50;
/** Account matters a kids profile does not see (and cannot dismiss for the grown-ups). */
const ADULT_ONLY: readonly NotificationType[] = ['billing', 'account_security', 'account_expiring'];

export interface NotificationViewer {
  userId: string;
  kids: boolean;
  /** The profile's library; notices about other sources are not shown. Absent/null = everything. */
  library?: ReadonlySet<string> | null;
}

const excluded = (viewer: NotificationViewer): NotificationScope => ({ exclude: viewer.kids ? ADULT_ONLY : [], library: viewer.library ? [...viewer.library] : null });
export const NOTIFICATION_RETENTION_DAYS = 30;

/** In-app notification center ("Source refreshed · 12 new channels added", "EPG updated", …). */
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Best effort: a notification must never fail the operation that produced it. */
  async notify(notification: NewNotification): Promise<void> {
    try {
      await this.notifications.upsert(notification, this.clock.now());
    } catch (error) {
      this.logger.warn({ err: error, type: notification.type }, 'Failed to store notification');
    }
  }

  /** The account's notifications as this viewer may see them (kids profiles: no billing or security). */
  async list(viewer: NotificationViewer): Promise<NotificationListDto> {
    const exclude = excluded(viewer);
    const [items, unread] = await Promise.all([this.notifications.list(viewer.userId, LIST_LIMIT, exclude), this.notifications.unreadCount(viewer.userId, exclude)]);
    return { items: items.map(toDto), unread };
  }

  async markRead(viewer: NotificationViewer, ids: string[] | 'all'): Promise<void> {
    await this.notifications.markRead(viewer.userId, ids, excluded(viewer));
  }

  async remove(viewer: NotificationViewer, id: string): Promise<void> {
    if (!(await this.notifications.deleteOwned(viewer.userId, id, excluded(viewer)))) throw AppError.notFound('Notification');
  }

  /** "Clear read": removes what was already seen. */
  async clearRead(viewer: NotificationViewer): Promise<number> {
    return this.notifications.deleteRead(viewer.userId, excluded(viewer));
  }

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
    return this.notifications.deleteOlderThan(cutoff);
  }
}

function toDto(record: NotificationRecord): NotificationDto {
  return {
    id: record.id,
    type: record.type,
    severity: record.severity,
    title: record.title,
    body: record.body,
    link: record.link,
    read: record.read,
    createdAt: record.createdAt.toISOString(),
  };
}
