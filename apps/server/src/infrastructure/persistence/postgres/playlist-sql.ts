import { sql, type Kysely } from 'kysely';

import { newEntityId } from '../../../domain/shared/ids.js';
import type { Database } from './schema.js';

/** Works for a Kysely instance and for a transaction (which extends it). */
export type Executor = Kysely<Database>;

/** Row-locks the playlist: edits of one playlist run one after another (positions stay consistent). */
export async function lockPlaylist(trx: Executor, playlistId: string): Promise<boolean> {
  const row = await trx.selectFrom('playlists').select('id').where('id', '=', playlistId).forUpdate().executeTakeFirst();
  return row !== undefined;
}

/**
 * Finds or creates groups by name (case-insensitive), in the order given. New groups go after
 * the existing ones. Call with the playlist locked. Keys of the result are lower-cased names.
 */
export async function ensureGroups(trx: Executor, playlistId: string, names: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (names.length === 0) return result;
  const existing = await trx.selectFrom('playlist_groups').select(['id', 'name']).where('playlist_id', '=', playlistId).execute();
  for (const group of existing) result.set(group.name.toLowerCase(), group.id);

  const toCreate: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (result.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCreate.push(name);
  }
  if (toCreate.length === 0) return result;

  const last = await trx.selectFrom('playlist_groups').select((eb) => eb.fn.max('position').as('max')).where('playlist_id', '=', playlistId).executeTakeFirst();
  let position = (last?.max ?? -1) + 1;
  await trx
    .insertInto('playlist_groups')
    .values(
      toCreate.map((name) => {
        const id = newEntityId();
        result.set(name.toLowerCase(), id);
        return { id, playlist_id: playlistId, name, position: position++ };
      }),
    )
    .execute();
  return result;
}

export interface InsertableEntry {
  name: string;
  logo: string | null;
  tvgId: string | null;
  number: number | null;
  sourceId: string;
  sourceKey: string;
  originNameKey: string;
  groupId: string | null;
}

/** 9 columns per row; stay far below the 65 535 bind-parameter limit. */
const ENTRY_CHUNK = 5_000;

/**
 * Inserts entries after the existing ones of each group (in the order given), skipping channels
 * already in the playlist. Call with the playlist locked. Returns how many were inserted.
 */
export async function insertEntries(trx: Executor, playlistId: string, entries: InsertableEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  const tails = await trx
    .selectFrom('playlist_entries')
    .select(['group_id', (eb) => eb.fn.max('position').as('max')])
    .where('playlist_id', '=', playlistId)
    .groupBy('group_id')
    .execute();
  const next = new Map<string | null, number>(tails.map((tail) => [tail.group_id, (tail.max ?? -1) + 1]));

  const rows = entries.map((entry) => {
    const position = next.get(entry.groupId) ?? 0;
    next.set(entry.groupId, position + 1);
    return {
      id: newEntityId(),
      playlist_id: playlistId,
      group_id: entry.groupId,
      position,
      number: entry.number,
      name: entry.name,
      logo: entry.logo,
      tvg_id: entry.tvgId,
      source_id: entry.sourceId,
      source_key: entry.sourceKey,
      origin_name_key: entry.originNameKey,
    };
  });

  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += ENTRY_CHUNK) {
    const result = await trx
      .insertInto('playlist_entries')
      .values(rows.slice(offset, offset + ENTRY_CHUNK))
      .onConflict((conflict) => conflict.columns(['playlist_id', 'source_id', 'source_key']).doNothing())
      .executeTakeFirst();
    inserted += Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
  return inserted;
}

export async function countEntries(trx: Executor, playlistId: string): Promise<number> {
  const row = await trx.selectFrom('playlist_entries').select((eb) => eb.fn.countAll<string>().as('n')).where('playlist_id', '=', playlistId).executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Thrown inside a transaction to roll it back when a limit would be exceeded. */
export class RollbackSignal extends Error {
  constructor(readonly reason: 'full' | 'group_not_found') {
    super(reason);
  }
}

/** Display order: ungrouped first, then groups in their order, entries by position. */
export const DISPLAY_ORDER = sql`g.position ASC NULLS FIRST, e.position ASC, e.id ASC`;
