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
  /** The sources the notice is about: only profiles that see one of them get it. Null = the whole account. */
  sourceIds: string[] | null;
}

export type NewNotification = Omit<NotificationRecord, 'id' | 'read' | 'createdAt' | 'sourceIds'> & { sourceIds?: string[] | null };

/** What one viewer of the account may see. */
export interface NotificationScope {
  /** Types left out (kids profiles: billing, security). */
  exclude?: readonly NotificationType[];
  /** The viewer's library: notices about other sources are left out. Null/undefined = everything. */
  library?: readonly string[] | null;
}

export interface NotificationRepository {
  /** Inserts, or refreshes an unread notification with the same dedupe key. */
  upsert(notification: NewNotification, now: Date): Promise<NotificationRecord>;
  /** Newest first; `scope` leaves out what this viewer must not see (kids profiles, other libraries). */
  list(ownerId: string, limit: number, scope?: NotificationScope): Promise<NotificationRecord[]>;
  unreadCount(ownerId: string, scope?: NotificationScope): Promise<number>;
  markRead(ownerId: string, ids: string[] | 'all', scope?: NotificationScope): Promise<void>;
  deleteOwned(ownerId: string, id: string, scope?: NotificationScope): Promise<boolean>;
  /** Removes the owner's read notifications (within the scope); returns how many. */
  deleteRead(ownerId: string, scope?: NotificationScope): Promise<number>;
  deleteOlderThan(cutoff: Date): Promise<number>;
  deleteForOwner(ownerId: string): Promise<void>;
}
