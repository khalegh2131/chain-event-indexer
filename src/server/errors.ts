import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { describeError } from '../utils/errors';
import type { ApiErrorBody } from '../types';

/**
 * Error model.
 *
 * Clients always receive `{ error: { message, code } }`; stack traces are logged
 * but never returned when running in production.
 */

export interface ErrorResponseBody extends ApiErrorBody {
  error: {
    message: string;
    code: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(
  message: string,
  code = 'VALIDATION_ERROR',
  details?: unknown,
): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = 'Unauthorized'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function notFound(message = 'Not found'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function internalError(message = 'Internal server error'): AppError {
  return new AppError(500, 'INTERNAL_ERROR', message);
}

export function serviceUnavailable(
  message = 'Service unavailable',
  code = 'SERVICE_UNAVAILABLE',
): AppError {
  return new AppError(503, code, message);
}

const STATUS_CODE_TO_ERROR_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export interface NormalizedError {
  statusCode: number;
  body: ErrorResponseBody;
}

export function toErrorResponse(error: unknown, isProduction: boolean): NormalizedError {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: {
          message: 'Invalid request parameters',
          code: 'VALIDATION_ERROR',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    };
  }

  if (error instanceof AppError) {
    const message =
      error.statusCode >= 500 && isProduction ? 'Internal server error' : error.message;
    const body: ErrorResponseBody = {
      error: {
        message,
        code: error.code,
      },
    };
    if (error.details !== undefined && error.statusCode < 500) {
      body.error.details = error.details;
    }
    return { statusCode: error.statusCode, body };
  }

  const fastifyError = error as Partial<FastifyError>;
  const statusCode =
    typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
      ? fastifyError.statusCode
      : 500;
  const rawMessage = describeError(error);
  const message =
    statusCode >= 500 && isProduction
      ? 'Internal server error'
      : rawMessage === ''
        ? 'Internal server error'
        : rawMessage;
  return {
    statusCode,
    body: {
      error: {
        message,
        code: STATUS_CODE_TO_ERROR_CODE[statusCode] ?? 'INTERNAL_ERROR',
      },
    },
  };
}

export interface ErrorHandlerOptions {
  logger: Logger;
  isProduction: boolean;
}

export function createErrorHandler(options: ErrorHandlerOptions) {
  return (error: unknown, request: FastifyRequest, reply: FastifyReply): void => {
    const normalized = toErrorResponse(error, options.isProduction);
    if (normalized.statusCode >= 500) {
      options.logger.error(
        { err: error, reqId: request.id, method: request.method, url: request.url },
        'request failed',
      );
    } else {
      options.logger.warn(
        {
          reqId: request.id,
          method: request.method,
          url: request.url,
          statusCode: normalized.statusCode,
          code: normalized.body.error.code,
        },
        'request rejected',
      );
    }
    void reply.status(normalized.statusCode).send(normalized.body);
  };
}

export function createNotFoundHandler() {
  return (request: FastifyRequest, reply: FastifyReply): void => {
    void reply.status(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        code: 'NOT_FOUND',
      },
    });
  };
}
