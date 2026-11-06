import { sql, type Kysely } from 'kysely';

import { canonicalGenres } from '../../../../domain/catalog/genres.js';

const BATCH = 2_000;

/**
 * Movie & series filters (Phase 15).
 *
 *   genre_ids   canonical genres (domain/catalog/genres) from the provider's genres and categories,
 *               so one genre filter works across sources and languages; GIN-indexed for `&&`.
 *
 * Existing rows are filled in here (new revisions get them at import).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ['movies', 'series'] as const) {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN genre_ids text[] NOT NULL DEFAULT '{}'`).execute(db);
    await backfill(db, table);
    await sql.raw(`CREATE INDEX ${table}_genre_ids_idx ON ${table} USING gin (genre_ids)`).execute(db);
  }
}

/** Fills `genre_ids` of existing rows (exported for the test). */
export async function backfill(db: Kysely<unknown>, table: 'movies' | 'series'): Promise<void> {
  let after: { source_id: string; revision: number; key: string } | null = null;
  for (;;) {
    const page: { rows: { source_id: string; revision: number; key: string; genres: string[]; groups: string[] }[] } = await sql<{
      source_id: string;
      revision: number;
      key: string;
      genres: string[];
      groups: string[];
    }>`
      SELECT source_id, revision, key, genres, groups FROM ${sql.table(table)}
       ${after ? sql`WHERE (source_id, revision, key) > (${after.source_id}, ${after.revision}, ${after.key})` : sql``}
       ORDER BY source_id, revision, key
       LIMIT ${BATCH}`.execute(db);
    if (page.rows.length === 0) return;
    const changed = page.rows.map((row) => ({ ...row, ids: canonicalGenres(row.genres, row.groups) })).filter((row) => row.ids.length > 0);
    if (changed.length > 0) {
      // text[][] cannot be ragged: genre lists travel as '|'-joined text and are split back.
      await sql`
        UPDATE ${sql.table(table)} AS t
           SET genre_ids = string_to_array(v.ids, '|')
          FROM unnest(${changed.map((row) => row.source_id)}::uuid[], ${changed.map((row) => row.revision)}::int[], ${changed.map((row) => row.key)}::text[], ${changed.map((row) => row.ids.join('|'))}::text[])
               AS v (source_id, revision, key, ids)
         WHERE t.source_id = v.source_id AND t.revision = v.revision AND t.key = v.key`.execute(db);
    }
    const last = page.rows.at(-1)!;
    after = { source_id: last.source_id, revision: last.revision, key: last.key };
  }
}
