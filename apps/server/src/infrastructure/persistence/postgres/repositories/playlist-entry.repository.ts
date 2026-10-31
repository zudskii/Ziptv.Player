import { sql } from 'kysely';

import type {
  AddEntriesResult,
  EntryFilter,
  EntryPatch,
  EntryRecord,
  EntryStats,
  EntryStatus,
  ExportRow,
  NewEntry,
  PlaylistEntryRepository,
  TransferPlacement,
  TransferResult,
} from '../../../../application/ports/playlist-repository.js';
import type { Db } from '../database.js';
import { analyzeAfterBulkLoad } from '../maintenance.js';
import { countEntries, ensureGroups, insertEntries, lockPlaylist, RollbackSignal, type Executor, type InsertableEntry } from '../playlist-sql.js';

/** An entry joined to its source, the channel it points at (current revision) and its group. */
function entryQuery(db: Executor) {
  return db
    .selectFrom('playlist_entries as e')
    .innerJoin('sources as s', 's.id', 'e.source_id')
    .leftJoin('live_channels as c', (join) => join.onRef('c.source_id', '=', 'e.source_id').onRef('c.revision', '=', 's.revision').onRef('c.key', '=', 'e.source_key'))
    .leftJoin('playlist_groups as g', 'g.id', 'e.group_id');
}

/** Derived, never stored: always matches what the source has right now. */
const STATUS = sql<EntryStatus>`CASE WHEN c.key IS NULL THEN 'missing' WHEN c.unplayable_reason IS NOT NULL OR c.locator IS NULL THEN 'unplayable' ELSE 'ok' END`;

/** Escapes LIKE wildcards so a search for "100%" means exactly that. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export class PgPlaylistEntryRepository implements PlaylistEntryRepository {
  constructor(private readonly db: Db) {}

  async addEntries(playlistId: string, entries: NewEntry[], options: { maxEntries: number }): Promise<AddEntriesResult> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        if (!(await lockPlaylist(trx, playlistId))) throw new RollbackSignal('group_not_found');

        const groupIds = await resolveGroups(trx, playlistId, entries.map((entry) => entry.group));
        const rows: InsertableEntry[] = entries.map((entry) => ({
          name: entry.name,
          logo: entry.logo,
          tvgId: entry.tvgId,
          number: null,
          sourceId: entry.sourceId,
          sourceKey: entry.sourceKey,
          originNameKey: entry.originNameKey,
          groupId: groupIds(entry.group),
        }));
        const added = await insertEntries(trx, playlistId, rows);
        // Exact limit check after the insert (duplicates were skipped, so counting first would guess).
        if ((await countEntries(trx, playlistId)) > options.maxEntries) throw new RollbackSignal('full');
        return { status: 'ok' as const, added, skipped: entries.length - added };
      });
      await analyzeAfterBulkLoad(this.db, 'playlist_entries', result.added);
      return result;
    } catch (error) {
      if (error instanceof RollbackSignal) return { status: error.reason === 'full' ? 'full' : 'group_not_found' };
      throw error;
    }
  }

  async list(playlistId: string, filter: EntryFilter, page: { offset: number; limit: number }): Promise<{ items: EntryRecord[]; total: number }> {
    const filtered = () => {
      let query = entryQuery(this.db).where('e.playlist_id', '=', playlistId);
      if (filter.group === 'ungrouped') query = query.where('e.group_id', 'is', null);
      else if (filter.group) query = query.where('e.group_id', '=', filter.group.id);
      if (filter.search) query = query.where(sql<boolean>`e.name ILIKE ${likePattern(filter.search)} ESCAPE '\\'`);
      if (filter.missingOnly) query = query.where('c.key', 'is', null);
      return query;
    };

    const [rows, count] = await Promise.all([
      filtered()
        .select(['e.id', 'e.playlist_id', 'e.group_id', 'e.position', 'e.number', 'e.name', 'e.logo', 'e.tvg_id', 'e.source_id', 'e.source_key', 's.name as source_name'])
        .select(STATUS.as('status'))
        .orderBy(sql`g.position ASC NULLS FIRST, e.position ASC, e.id ASC`)
        .limit(page.limit)
        .offset(page.offset)
        .execute(),
      filtered().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toEntry), total: Number(count.n) };
  }

  async stats(playlistId: string): Promise<EntryStats> {
    const row = await entryQuery(this.db)
      .where('e.playlist_id', '=', playlistId)
      .select([
        (eb) => eb.fn.countAll<string>().as('total'),
        sql<string>`count(*) FILTER (WHERE c.key IS NULL)`.as('missing'),
        sql<string>`count(*) FILTER (WHERE e.group_id IS NULL)`.as('ungrouped'),
      ])
      .executeTakeFirstOrThrow();
    return { total: Number(row.total), missing: Number(row.missing), ungrouped: Number(row.ungrouped) };
  }

  async update(playlistId: string, entryId: string, patch: EntryPatch): Promise<EntryRecord | null> {
    const set = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.logo !== undefined ? { logo: patch.logo } : {}),
      ...(patch.tvgId !== undefined ? { tvg_id: patch.tvgId } : {}),
      ...(patch.number !== undefined ? { number: patch.number } : {}),
    };
    if (Object.keys(set).length > 0) {
      const result = await this.db.updateTable('playlist_entries').set(set).where('id', '=', entryId).where('playlist_id', '=', playlistId).executeTakeFirst();
      if (result.numUpdatedRows === 0n) return null;
    }
    const row = await entryQuery(this.db)
      .where('e.playlist_id', '=', playlistId)
      .where('e.id', '=', entryId)
      .select(['e.id', 'e.playlist_id', 'e.group_id', 'e.position', 'e.number', 'e.name', 'e.logo', 'e.tvg_id', 'e.source_id', 'e.source_key', 's.name as source_name'])
      .select(STATUS.as('status'))
      .executeTakeFirst();
    return row ? toEntry(row) : null;
  }

  async move(playlistId: string, entryIds: string[], target: { groupId: string | null; beforeEntryId: string | null }): Promise<{ moved: number } | 'group_not_found'> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPlaylist(trx, playlistId))) return { moved: 0 };
      if (target.groupId) {
        const group = await trx.selectFrom('playlist_groups').select('id').where('id', '=', target.groupId).where('playlist_id', '=', playlistId).executeTakeFirst();
        if (!group) return 'group_not_found' as const;
      }

      // The moved entries, in the order the user sees them (not the order of the request).
      const moved = (
        await trx
          .selectFrom('playlist_entries as e')
          .leftJoin('playlist_groups as g', 'g.id', 'e.group_id')
          .select('e.id')
          .where('e.playlist_id', '=', playlistId)
          .where('e.id', 'in', entryIds)
          .orderBy(sql`g.position ASC NULLS FIRST, e.position ASC, e.id ASC`)
          .execute()
      ).map((row) => row.id);
      if (moved.length === 0) return { moved: 0 };

      const inTarget = (query: ReturnType<typeof baseTargetQuery>) => (target.groupId ? query.where('group_id', '=', target.groupId) : query.where('group_id', 'is', null));
      const baseTargetQuery = () => trx.selectFrom('playlist_entries').where('playlist_id', '=', playlistId).where('id', 'not in', moved);

      const rest = await inTarget(baseTargetQuery()).select(['id', 'position']).orderBy('position').orderBy('id').execute();
      const beforeIndex = target.beforeEntryId ? rest.findIndex((row) => row.id === target.beforeEntryId) : -1;

      if (beforeIndex === -1) {
        // Appending: only the moved entries are touched, however large the target group is.
        const base = rest.length > 0 ? rest[rest.length - 1]!.position + 1 : 0;
        await writePositions(trx, playlistId, target.groupId, moved, moved.map((_, index) => base + index));
      } else {
        // Inserting in the middle: renumber the target group once.
        const order = [...rest.slice(0, beforeIndex).map((row) => row.id), ...moved, ...rest.slice(beforeIndex).map((row) => row.id)];
        await writePositions(trx, playlistId, target.groupId, order, order.map((_, index) => index));
      }
      return { moved: moved.length };
    });
  }

  async remove(playlistId: string, entryIds: string[]): Promise<number> {
    if (entryIds.length === 0) return 0;
    const result = await this.db.deleteFrom('playlist_entries').where('playlist_id', '=', playlistId).where('id', 'in', entryIds).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async renumber(playlistId: string, numbering: { start: number; step: number }): Promise<number> {
    const result = await sql`
      UPDATE playlist_entries e
         SET number = ${numbering.start} + (r.rn - 1) * ${numbering.step}
        FROM (
          SELECT x.id, row_number() OVER (ORDER BY g.position ASC NULLS FIRST, x.position, x.id) AS rn
            FROM playlist_entries x LEFT JOIN playlist_groups g ON g.id = x.group_id
           WHERE x.playlist_id = ${playlistId}
        ) r
       WHERE e.id = r.id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  async transfer(input: {
    fromPlaylistId: string;
    toPlaylistId: string;
    entryIds: string[] | 'all';
    mode: 'copy' | 'move';
    placement: TransferPlacement;
    maxEntries: number;
  }): Promise<TransferResult> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        // Lock both playlists in a fixed order so two opposite transfers cannot deadlock.
        for (const id of [input.fromPlaylistId, input.toPlaylistId].sort()) {
          if (!(await lockPlaylist(trx, id))) throw new RollbackSignal('group_not_found');
        }

        let query = trx
          .selectFrom('playlist_entries as e')
          .leftJoin('playlist_groups as g', 'g.id', 'e.group_id')
          .select(['e.id', 'e.name', 'e.logo', 'e.tvg_id', 'e.number', 'e.source_id', 'e.source_key', 'e.origin_name_key', 'g.name as group_name'])
          .where('e.playlist_id', '=', input.fromPlaylistId)
          .orderBy(sql`g.position ASC NULLS FIRST, e.position ASC, e.id ASC`);
        if (input.entryIds !== 'all') query = query.where('e.id', 'in', input.entryIds);
        const selected = await query.execute();
        if (selected.length === 0) return { status: 'ok' as const, transferred: 0, skipped: 0 };

        const groupIds = await resolveGroups(
          trx,
          input.toPlaylistId,
          selected.map((row) => (input.placement.by === 'name' ? (row.group_name ? { name: row.group_name } : null) : input.placement.groupId ? { id: input.placement.groupId } : null)),
        );
        const rows: InsertableEntry[] = selected.map((row) => ({
          name: row.name,
          logo: row.logo,
          tvgId: row.tvg_id,
          number: row.number,
          sourceId: row.source_id,
          sourceKey: row.source_key,
          originNameKey: row.origin_name_key,
          groupId: groupIds(input.placement.by === 'name' ? (row.group_name ? { name: row.group_name } : null) : input.placement.groupId ? { id: input.placement.groupId } : null),
        }));

        const inserted = await insertEntries(trx, input.toPlaylistId, rows);
        if ((await countEntries(trx, input.toPlaylistId)) > input.maxEntries) throw new RollbackSignal('full');
        if (input.mode === 'move') {
          // Everything selected ends up in the target (newly or already there): take it out of the source.
          await trx.deleteFrom('playlist_entries').where('playlist_id', '=', input.fromPlaylistId).where('id', 'in', selected.map((row) => row.id)).execute();
        }
        return { status: 'ok' as const, transferred: inserted, skipped: selected.length - inserted };
      });
      if (result.status === 'ok') await analyzeAfterBulkLoad(this.db, 'playlist_entries', result.transferred);
      return result;
    } catch (error) {
      if (error instanceof RollbackSignal) return { status: error.reason === 'full' ? 'full' : 'group_not_found' };
      throw error;
    }
  }

  async relink(scope: { playlistId: string } | { sourceId: string }): Promise<number> {
    const where = 'playlistId' in scope ? sql`e.playlist_id = ${scope.playlistId}` : sql`e.source_id = ${scope.sourceId}`;
    const result = await sql`
      WITH candidates AS (
        SELECT e.id AS entry_id, e.playlist_id, e.source_id, min(c.key) AS new_key
          FROM playlist_entries e
          JOIN sources s        ON s.id = e.source_id
          JOIN live_channels c  ON c.source_id = s.id AND c.revision = s.revision AND c.name_key = e.origin_name_key
         WHERE ${where}
           AND e.origin_name_key <> ''
           AND NOT EXISTS (SELECT 1 FROM live_channels cur WHERE cur.source_id = s.id AND cur.revision = s.revision AND cur.key = e.source_key)
         GROUP BY e.id, e.playlist_id, e.source_id
        HAVING count(*) = 1
      ), one_per_target AS (
        SELECT DISTINCT ON (playlist_id, source_id, new_key) entry_id, playlist_id, source_id, new_key
          FROM candidates
         ORDER BY playlist_id, source_id, new_key, entry_id
      )
      UPDATE playlist_entries e
         SET source_key = t.new_key
        FROM one_per_target t
       WHERE e.id = t.entry_id
         AND NOT EXISTS (SELECT 1 FROM playlist_entries o WHERE o.playlist_id = t.playlist_id AND o.source_id = t.source_id AND o.source_key = t.new_key)`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Walks the playlist in display order, group by group, `batchSize` rows per query. Within a group
   * the rows come straight off the (playlist, group, position) index and the next batch starts after
   * the last row seen, so every query is short and the whole walk is linear however long the playlist
   * is (and no connection is held between batches).
   *
   * The batch of entries is cut first and only then joined to the catalog. Filtering on the catalog
   * inside one big join lets the planner start from the whole catalog (50 000 rows) instead of from
   * the ~500 entries at hand: 245 ms per group instead of ~2 ms.
   */
  async *exportBatches(playlistId: string, batchSize: number): AsyncGenerator<ExportRow[]> {
    const groups = await this.db.selectFrom('playlist_groups').select(['id', 'name']).where('playlist_id', '=', playlistId).orderBy('position').orderBy('id').execute();
    const scopes: { id: string | null; name: string | null }[] = [{ id: null, name: null }, ...groups]; // ungrouped first

    for (const scope of scopes) {
      let after: { position: number; id: string } | null = null;
      for (;;) {
        let cut = this.db
          .selectFrom('playlist_entries as e')
          .select(['e.id', 'e.position', 'e.name', 'e.number', 'e.logo', 'e.tvg_id', 'e.source_id', 'e.source_key'])
          .where('e.playlist_id', '=', playlistId);
        cut = scope.id === null ? cut.where('e.group_id', 'is', null) : cut.where('e.group_id', '=', scope.id);
        if (after) cut = cut.where(sql<boolean>`(e.position, e.id) > (${after.position}, ${after.id}::uuid)`);

        const rows = await this.db
          .selectFrom(cut.orderBy('e.position').orderBy('e.id').limit(batchSize).as('b'))
          .innerJoin('sources as s', 's.id', 'b.source_id')
          .leftJoin('live_channels as c', (join) => join.onRef('c.source_id', '=', 'b.source_id').onRef('c.revision', '=', 's.revision').onRef('c.key', '=', 'b.source_key'))
          .select(['b.id as entry_id', 'b.position', 'b.name', 'b.number', 'b.logo', 'b.tvg_id', 'c.locator', 'c.catchup'])
          .orderBy('b.position')
          .orderBy('b.id')
          .execute();
        if (rows.length === 0) break;

        // Entries whose channel vanished or has no stream URL are simply not part of the file.
        const exportable = rows.filter((row) => row.locator !== null);
        if (exportable.length > 0) {
          yield exportable.map((row) => ({ name: row.name, number: row.number, logo: row.logo, tvgId: row.tvg_id, groupName: scope.name, locator: row.locator!, catchup: row.catchup }));
        }
        if (rows.length < batchSize) break;
        const last = rows[rows.length - 1]!;
        after = { position: last.position, id: last.entry_id };
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------

function toEntry(row: {
  id: string;
  playlist_id: string;
  group_id: string | null;
  position: number;
  number: number | null;
  name: string;
  logo: string | null;
  tvg_id: string | null;
  source_id: string;
  source_key: string;
  source_name: string;
  status: EntryStatus;
}): EntryRecord {
  return {
    id: row.id,
    playlistId: row.playlist_id,
    groupId: row.group_id,
    position: row.position,
    number: row.number,
    name: row.name,
    logo: row.logo,
    tvgId: row.tvg_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceKey: row.source_key,
    status: row.status,
  };
}

type Target = { name: string } | { id: string } | null;

/**
 * Turns group targets into group ids: creates groups that are named but absent, and checks that
 * the ids given exist in this playlist. Returns a lookup for a target; throws a rollback when an id is foreign.
 */
async function resolveGroups(trx: Executor, playlistId: string, targets: Target[]): Promise<(target: Target) => string | null> {
  const names: string[] = [];
  const ids = new Set<string>();
  for (const target of targets) {
    if (target && 'name' in target) names.push(target.name);
    else if (target) ids.add(target.id);
  }
  const byName = await ensureGroups(trx, playlistId, names);
  if (ids.size > 0) {
    const found = await trx.selectFrom('playlist_groups').select('id').where('playlist_id', '=', playlistId).where('id', 'in', [...ids]).execute();
    if (found.length !== ids.size) throw new RollbackSignal('group_not_found');
  }
  return (target) => (!target ? null : 'name' in target ? (byName.get(target.name.toLowerCase()) ?? null) : target.id);
}

/** Sets group and positions of the listed entries in one statement. */
async function writePositions(trx: Executor, playlistId: string, groupId: string | null, entryIds: string[], positions: number[]): Promise<void> {
  await sql`
    UPDATE playlist_entries e
       SET group_id = ${groupId}::uuid, position = v.pos
      FROM unnest(${entryIds}::uuid[], ${positions}::int[]) AS v (id, pos)
     WHERE e.id = v.id AND e.playlist_id = ${playlistId}`.execute(trx);
}
