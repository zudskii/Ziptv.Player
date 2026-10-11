import type { NotificationDto, NotificationListDto } from '@ziptv/contracts';

import { AppError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { NewNotification, NotificationRecord, NotificationRepository } from '../ports/notification-repository.js';

const LIST_LIMIT = 50;
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

  async list(ownerId: string): Promise<NotificationListDto> {
    const [items, unread] = await Promise.all([this.notifications.list(ownerId, LIST_LIMIT), this.notifications.unreadCount(ownerId)]);
    return { items: items.map(toDto), unread };
  }

  async markRead(ownerId: string, ids: string[] | 'all'): Promise<void> {
    await this.notifications.markRead(ownerId, ids);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    if (!(await this.notifications.deleteOwned(ownerId, id))) throw AppError.notFound('Notification');
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
