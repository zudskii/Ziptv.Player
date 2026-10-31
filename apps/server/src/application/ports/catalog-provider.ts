import type { CatalogBuild } from '../../domain/catalog/model.js';
import type { SourceCredential, SourceProblem, SyncStage } from '../../domain/sources/source.js';

export interface FetchContext {
  signal: AbortSignal;
  /** Reports progress ("Connecting…", "Parsing channels…") for the onboarding screen. */
  onStage(stage: SyncStage): Promise<void>;
}

/** Reads a whole catalog from a provider (M3U URL, Xtream API). */
export interface CatalogProvider {
  fetchCatalog(credential: SourceCredential, context: FetchContext): Promise<CatalogBuild>;
}

/** Checks that credentials are accepted (before switching a source to them). */
export interface AccountVerifier {
  /** Throws SourceFetchError (auth_failed / unavailable / …) when the account cannot be used. */
  verifyAccount(credential: SourceCredential, signal: AbortSignal): Promise<void>;
}

/** Parses an uploaded playlist file. */
export interface PlaylistFileParser {
  parseFile(bytes: Buffer, fileName: string): CatalogBuild;
}

/**
 * Failure of a provider adapter, already classified for the UX
 * (auth_failed → "Authentication failed", expired → "Playlist expired", …).
 */
export class SourceFetchError extends Error {
  constructor(
    readonly problem: SourceProblem,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SourceFetchError';
  }
}
