import type { ApiErrorBody } from '@ziptv/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import type {} from 'pino-http'; // brings the req.id / req.log type augmentation

import { AppError, isAppError } from '../../application/errors.js';
import type { Logger } from '../../application/ports/logger.js';

export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError('NOT_FOUND', 404, `Route ${req.method} ${req.path} does not exist.`);
};

/**
 * Last middleware. Converts every thrown value into the `ApiErrorBody` shape; only AppError
 * messages are exposed, everything else is logged with the request id and hidden.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const appError = toAppError(error);
    const requestId = typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : undefined;

    if (appError.status >= 500) {
      (req.log ?? logger).error({ err: error, requestId }, 'Unhandled error');
    } else {
      (req.log ?? logger).debug({ code: appError.code, message: appError.message }, 'Request rejected');
    }

    if (res.headersSent) {
      // Streaming response already started (proxy): the only safe thing left is to cut it.
      res.destroy();
      return;
    }

    const body: ApiErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(appError.status).json(body);
  };
}

function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof multer.MulterError) {
    return error.code === 'LIMIT_FILE_SIZE'
      ? new AppError('PAYLOAD_TOO_LARGE', 413, 'The file is too large.')
      : AppError.validation(`Upload rejected: ${error.message}`);
  }

  // Framework errors (body-parser, serve-static) follow the http-errors shape: status + type.
  const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
  const type = (error as { type?: string }).type;
  if (status === 413 || type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 413, 'Request body is too large.');
  if (type === 'entity.parse.failed') return AppError.validation('Request body is not valid JSON.');
  if (status === 404) return new AppError('NOT_FOUND', 404, 'Not found.');
  if (typeof status === 'number' && status >= 400 && status < 500) return new AppError('VALIDATION_ERROR', status, 'Bad request.');

  return new AppError('INTERNAL_ERROR', 500, 'Something went wrong on our side.', undefined, { cause: error });
}
