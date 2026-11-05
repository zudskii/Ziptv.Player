import type { LibraryRepository } from '../../../../application/ports/library-repository.js';
import type { Db } from '../database.js';

export class PgLibraryRepository implements LibraryRepository {
  constructor(private readonly db: Db) {}

  async librariesOf(userId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.db
      .selectFrom('profile_sources as ps')
      .innerJoin('profiles as p', 'p.id', 'ps.profile_id')
      .select(['ps.profile_id', 'ps.source_id'])
      .where('p.user_id', '=', userId)
      .execute();
    const libraries = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = libraries.get(row.profile_id);
      if (set) set.add(row.source_id);
      else libraries.set(row.profile_id, new Set([row.source_id]));
    }
    return libraries;
  }

  async setProfileSources(profileId: string, sourceIds: readonly string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      let remove = trx.deleteFrom('profile_sources').where('profile_id', '=', profileId);
      if (sourceIds.length > 0) remove = remove.where('source_id', 'not in', [...sourceIds]);
      await remove.execute();
      if (sourceIds.length > 0) {
        await trx
          .insertInto('profile_sources')
          .values(sourceIds.map((sourceId) => ({ profile_id: profileId, source_id: sourceId })))
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      }
    });
  }

  async setSourceProfiles(sourceId: string, profileIds: readonly string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      let remove = trx.deleteFrom('profile_sources').where('source_id', '=', sourceId);
      if (profileIds.length > 0) remove = remove.where('profile_id', 'not in', [...profileIds]);
      await remove.execute();
      if (profileIds.length > 0) {
        await trx
          .insertInto('profile_sources')
          .values(profileIds.map((profileId) => ({ profile_id: profileId, source_id: sourceId })))
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      }
    });
  }

  async addToProfile(profileId: string, sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.db
      .insertInto('profile_sources')
      .values(sourceIds.map((sourceId) => ({ profile_id: profileId, source_id: sourceId })))
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
}
