import { sql, type Selectable } from 'kysely';

import type { GroupRecord, PlaylistRecord, PlaylistRepository, PlaylistSummaryRecord } from '../../../../application/ports/playlist-repository.js';
import type { Db } from '../database.js';
import { isUniqueViolation } from '../errors.js';
import { lockPlaylist } from '../playlist-sql.js';
import type { PlaylistsTable } from '../schema.js';

function toRecord(row: Selectable<PlaylistsTable>): PlaylistRecord {
  return { id: row.id, ownerId: row.owner_id, name: row.name, exportEnabled: row.export_token_hash !== null, exportTokenHash: row.export_token_hash, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class PgPlaylistRepository implements PlaylistRepository {
  constructor(private readonly db: Db) {}

  async countByOwner(ownerId: string): Promise<number> {
    const row = await this.db.selectFrom('playlists').select((eb) => eb.fn.countAll<string>().as('n')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async create(playlist: { id: string; ownerId: string; name: string }): Promise<PlaylistRecord> {
    const row = await this.db
      .insertInto('playlists')
      .values({ id: playlist.id, owner_id: playlist.ownerId, name: playlist.name, export_token_hash: null, export_token_sealed: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async list(ownerId: string): Promise<PlaylistSummaryRecord[]> {
    // Counts come from two small aggregates; the (heavier) missing-channel count is left to the detail view.
    const rows = await this.db
      .selectFrom('playlists as p')
      .selectAll('p')
      .select([
        (eb) => eb.selectFrom('playlist_entries as e').select((q) => q.fn.countAll<string>().as('n')).whereRef('e.playlist_id', '=', 'p.id').as('entry_count'),
        (eb) => eb.selectFrom('playlist_groups as g').select((q) => q.fn.countAll<string>().as('n')).whereRef('g.playlist_id', '=', 'p.id').as('group_count'),
      ])
      .where('p.owner_id', '=', ownerId)
      .orderBy('p.created_at')
      .execute();
    return rows.map((row) => ({ ...toRecord(row), entryCount: Number(row.entry_count ?? 0), groupCount: Number(row.group_count ?? 0) }));
  }

  async findOwned(id: string, ownerId: string): Promise<PlaylistRecord | null> {
    const row = await this.db.selectFrom('playlists').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async rename(id: string, ownerId: string, name: string): Promise<PlaylistRecord | null> {
    const row = await this.db.updateTable('playlists').set({ name, updated_at: sql<Date>`now()` }).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('playlists').where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  // --- export link --------------------------------------------------------------------------

  async setExportToken(id: string, ownerId: string, token: { hash: string; sealed: string } | null): Promise<boolean> {
    const result = await this.db
      .updateTable('playlists')
      .set({ export_token_hash: token?.hash ?? null, export_token_sealed: token?.sealed ?? null })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async getExportTokenSealed(id: string, ownerId: string): Promise<string | null> {
    const row = await this.db.selectFrom('playlists').select('export_token_sealed').where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return row?.export_token_sealed ?? null;
  }

  async findByExportTokenHash(hash: string): Promise<PlaylistRecord | null> {
    const row = await this.db.selectFrom('playlists').selectAll().where('export_token_hash', '=', hash).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  // --- groups -------------------------------------------------------------------------------

  async listGroups(playlistId: string): Promise<GroupRecord[]> {
    // One pass over the playlist's entries. (A correlated count per group rescans every entry for
    // every group: 100 groups × 50 000 entries took 4 s.)
    const rows = await this.db
      .selectFrom('playlist_groups as g')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('playlist_entries')
            .select(['group_id', (q) => q.fn.countAll<string>().as('n')])
            .where('playlist_id', '=', playlistId)
            .where('group_id', 'is not', null)
            .groupBy('group_id')
            .as('c'),
        (join) => join.onRef('c.group_id', '=', 'g.id'),
      )
      .select(['g.id', 'g.playlist_id', 'g.name', 'g.position', 'c.n as entry_count'])
      .where('g.playlist_id', '=', playlistId)
      .orderBy('g.position')
      .orderBy('g.id')
      .execute();
    return rows.map((row) => ({ id: row.id, playlistId: row.playlist_id, name: row.name, position: row.position, entryCount: Number(row.entry_count ?? 0) }));
  }

  async createGroup(playlistId: string, id: string, name: string): Promise<GroupRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPlaylist(trx, playlistId))) return null;
      const last = await trx.selectFrom('playlist_groups').select((eb) => eb.fn.max('position').as('max')).where('playlist_id', '=', playlistId).executeTakeFirst();
      try {
        const row = await trx
          .insertInto('playlist_groups')
          .values({ id, playlist_id: playlistId, name, position: (last?.max ?? -1) + 1 })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { id: row.id, playlistId: row.playlist_id, name: row.name, position: row.position, entryCount: 0 };
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    });
  }

  async renameGroup(playlistId: string, groupId: string, name: string): Promise<'ok' | 'duplicate' | 'not_found'> {
    try {
      const result = await this.db.updateTable('playlist_groups').set({ name }).where('id', '=', groupId).where('playlist_id', '=', playlistId).executeTakeFirst();
      return result.numUpdatedRows > 0n ? 'ok' : 'not_found';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  async reorderGroups(playlistId: string, groupIds: string[]): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPlaylist(trx, playlistId))) return false;
      const existing = await trx.selectFrom('playlist_groups').select('id').where('playlist_id', '=', playlistId).execute();
      if (existing.length !== groupIds.length || new Set(groupIds).size !== groupIds.length) return false;
      const known = new Set(existing.map((group) => group.id));
      if (!groupIds.every((id) => known.has(id))) return false;
      if (groupIds.length > 0) {
        const positions = groupIds.map((_, index) => index);
        await sql`UPDATE playlist_groups g SET position = v.pos FROM unnest(${groupIds}::uuid[], ${positions}::int[]) AS v (id, pos) WHERE g.id = v.id AND g.playlist_id = ${playlistId}`.execute(trx);
      }
      return true;
    });
  }

  async deleteGroup(playlistId: string, groupId: string, deleteEntries: boolean): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPlaylist(trx, playlistId))) return false;
      const group = await trx.selectFrom('playlist_groups').select('id').where('id', '=', groupId).where('playlist_id', '=', playlistId).executeTakeFirst();
      if (!group) return false;

      if (deleteEntries) {
        await trx.deleteFrom('playlist_entries').where('playlist_id', '=', playlistId).where('group_id', '=', groupId).execute();
      } else {
        // Keep their order, after whatever is already ungrouped.
        const tail = await trx.selectFrom('playlist_entries').select((eb) => eb.fn.max('position').as('max')).where('playlist_id', '=', playlistId).where('group_id', 'is', null).executeTakeFirst();
        await sql`
          UPDATE playlist_entries e
             SET group_id = NULL, position = ${(tail?.max ?? -1) + 1} + r.rn - 1
            FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM playlist_entries WHERE playlist_id = ${playlistId} AND group_id = ${groupId}) r
           WHERE e.id = r.id`.execute(trx);
      }
      await trx.deleteFrom('playlist_groups').where('id', '=', groupId).execute();
      return true;
    });
  }
}
