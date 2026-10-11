import type { NotificationType } from '@ziptv/contracts';

export interface NotificationRecord {
  id: string;
  ownerId: string;
  type: NotificationType;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  /** Same key within the dedupe window replaces the older notification instead of stacking. */
  dedupeKey: string | null;
  createdAt: Date;
}

export type NewNotification = Omit<NotificationRecord, 'id' | 'read' | 'createdAt'>;

export interface NotificationRepository {
  /** Inserts, or refreshes an unread notification with the same dedupe key. */
  upsert(notification: NewNotification, now: Date): Promise<NotificationRecord>;
  list(ownerId: string, limit: number): Promise<NotificationRecord[]>;
  unreadCount(ownerId: string): Promise<number>;
  markRead(ownerId: string, ids: string[] | 'all'): Promise<void>;
  deleteOwned(ownerId: string, id: string): Promise<boolean>;
  deleteOlderThan(cutoff: Date): Promise<number>;
  deleteForOwner(ownerId: string): Promise<void>;
}
