import type { ApiErrorCode } from '@ziptv/contracts';

/**
 * The only error type that is allowed to reach HTTP clients with its message intact.
 * Anything else is logged and turned into a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('VALIDATION_ERROR', 400, message, details);
  }

  static unauthorized(message = 'Missing or invalid session token.'): AppError {
    return new AppError('UNAUTHORIZED', 401, message);
  }

  static forbidden(message = 'Forbidden.'): AppError {
    return new AppError('FORBIDDEN', 403, message);
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', 404, `${what} not found.`);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
