/**
 * Feed selection: a master channel may have several licensed feeds (primary/backup from
 * different providers). Playable = feed active, its provider active and its stream still offered;
 * order = priority (lower first), then age. Health-based failover builds on this order.
 */
export interface FeedCandidate {
  id: string;
  priority: number;
  status: 'active' | 'disabled';
  providerStatus: 'active' | 'paused' | 'terminated';
  streamStatus: 'pending' | 'matched' | 'ignored' | 'gone';
  createdAt: Date;
}

export function playableFeeds<T extends FeedCandidate>(feeds: readonly T[]): T[] {
  return feeds
    .filter((feed) => feed.status === 'active' && feed.providerStatus === 'active' && feed.streamStatus === 'matched')
    .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
}
