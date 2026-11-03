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
  /** Newest first; `exclude` leaves out types this viewer must not see (kids profiles). */
  list(ownerId: string, limit: number, exclude?: readonly NotificationType[]): Promise<NotificationRecord[]>;
  unreadCount(ownerId: string, exclude?: readonly NotificationType[]): Promise<number>;
  markRead(ownerId: string, ids: string[] | 'all', exclude?: readonly NotificationType[]): Promise<void>;
  deleteOwned(ownerId: string, id: string, exclude?: readonly NotificationType[]): Promise<boolean>;
  /** Removes the owner's read notifications; returns how many. */
  deleteRead(ownerId: string, exclude?: readonly NotificationType[]): Promise<number>;
  deleteOlderThan(cutoff: Date): Promise<number>;
  deleteForOwner(ownerId: string): Promise<void>;
}
