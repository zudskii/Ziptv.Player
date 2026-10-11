import type { z } from 'zod';

import { AppError } from '../../application/errors.js';

/** Parses untrusted input with a zod schema; failures become a 400 with field-level details. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what = 'Request'): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    const first = details[0];
    throw AppError.validation(first ? `${what} is invalid: ${first.path || 'value'} — ${first.message}` : `${what} is invalid`, details);
  }
  return result.data;
}
