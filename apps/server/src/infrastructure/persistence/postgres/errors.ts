/** Postgres SQLSTATE 23505: a UNIQUE constraint or index was violated. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
