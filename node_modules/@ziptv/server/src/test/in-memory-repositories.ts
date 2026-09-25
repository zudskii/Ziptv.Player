import { randomBytes } from 'node:crypto';

import type { ParsedChannel } from '../modules/m3u/index.js';
import type { ChannelRecord, ChannelRepository, ChannelSummary } from '../modules/playlists/channel.repository.js';
import type {
  PlaylistRecord,
  PlaylistRepository,
  PlaylistSnapshot,
  PlaylistSource,
} from '../modules/playlists/playlist.repository.js';
import type { UserRecord, UserRepository } from '../modules/session/user.repository.js';

const newObjectId = (): string => randomBytes(12).toString('hex');

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, UserRecord & { tokenHash: string; legacySecretId?: string }>();

  async create(tokenHash: string): Promise<UserRecord> {
    const user = { id: newObjectId(), tokenHash, createdAt: new Date(), lastSeenAt: new Date() };
    this.users.set(user.id, user);
    return user;
  }

  async findByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((user) => user.tokenHash === tokenHash) ?? null;
  }

  async claimLegacy(legacySecretId: string, tokenHash: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.legacySecretId === legacySecretId);
    if (!user) return null;
    user.tokenHash = tokenHash;
    delete user.legacySecretId;
    return user;
  }

  async touch(id: string, at: Date): Promise<void> {
    const user = this.users.get(id);
    if (user) user.lastSeenAt = at;
  }
}

export class InMemoryPlaylistRepository implements PlaylistRepository {
  readonly playlists = new Map<string, PlaylistRecord>();

  newId(): string {
    return newObjectId();
  }

  isValidId(id: string): boolean {
    return /^[a-f0-9]{24}$/.test(id);
  }

  async countByOwner(ownerId: string): Promise<number> {
    return [...this.playlists.values()].filter((p) => p.ownerId === ownerId).length;
  }

  async listByOwner(ownerId: string): Promise<PlaylistRecord[]> {
    return [...this.playlists.values()].filter((p) => p.ownerId === ownerId);
  }

  async findOwned(id: string, ownerId: string): Promise<PlaylistRecord | null> {
    const playlist = this.playlists.get(id);
    return playlist?.ownerId === ownerId ? playlist : null;
  }

  async findById(id: string): Promise<PlaylistRecord | null> {
    return this.playlists.get(id) ?? null;
  }

  async create(input: { id: string; ownerId: string; name: string; source: PlaylistSource; snapshot: PlaylistSnapshot }): Promise<PlaylistRecord> {
    const now = new Date();
    const record: PlaylistRecord = { id: input.id, ownerId: input.ownerId, name: input.name, source: input.source, ...input.snapshot, createdAt: now, updatedAt: now };
    this.playlists.set(record.id, record);
    return record;
  }

  async replaceSnapshot(id: string, expectedRevision: number, snapshot: PlaylistSnapshot): Promise<PlaylistRecord | null> {
    const playlist = this.playlists.get(id);
    if (!playlist || playlist.revision !== expectedRevision) return null;
    const updated = { ...playlist, ...snapshot, updatedAt: new Date() };
    this.playlists.set(id, updated);
    return updated;
  }

  async rename(id: string, ownerId: string, name: string): Promise<PlaylistRecord | null> {
    const playlist = await this.findOwned(id, ownerId);
    if (!playlist) return null;
    const updated = { ...playlist, name, updatedAt: new Date() };
    this.playlists.set(id, updated);
    return updated;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    if (!(await this.findOwned(id, ownerId))) return false;
    return this.playlists.delete(id);
  }
}

export class InMemoryChannelRepository implements ChannelRepository {
  readonly rows: Array<ChannelRecord & { playlistId: string; revision: number }> = [];

  async insertRevision(playlistId: string, revision: number, channels: ParsedChannel[]): Promise<void> {
    for (const channel of channels) this.rows.push({ ...channel, playlistId, revision });
  }

  async listSummaries(playlistId: string, revision: number): Promise<ChannelSummary[]> {
    return this.rows
      .filter((row) => row.playlistId === playlistId && row.revision === revision)
      .sort((a, b) => a.position - b.position)
      .map(({ key, name, groups, logo, tvgId, kind, unplayableReason }) => ({ key, name, groups, logo, tvgId, kind, unplayableReason }));
  }

  async findByKey(playlistId: string, revision: number, key: string): Promise<ChannelRecord | null> {
    return this.rows.find((row) => row.playlistId === playlistId && row.revision === revision && row.key === key) ?? null;
  }

  async deleteRevision(playlistId: string, revision: number): Promise<void> {
    this.remove((row) => row.playlistId === playlistId && row.revision === revision);
  }

  async deleteRevisionsExcept(playlistId: string, revision: number): Promise<void> {
    this.remove((row) => row.playlistId === playlistId && row.revision !== revision);
  }

  async deleteAll(playlistId: string): Promise<void> {
    this.remove((row) => row.playlistId === playlistId);
  }

  private remove(predicate: (row: (typeof this.rows)[number]) => boolean): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row && predicate(row)) this.rows.splice(i, 1);
    }
  }
}
