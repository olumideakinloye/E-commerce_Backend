export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad Request', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details?: unknown) {
    super(message, 401, 'UNAUTHORIZED', details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource Not Found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = 'Unprocessable Entity', details?: unknown) {
    super(message, 422, 'UNPROCESSABLE_ENTITY', details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too Many Requests', details?: unknown) {
    super(message, 429, 'TOO_MANY_REQUESTS', details);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal Server Error', details?: unknown) {
    super(message, 500, 'INTERNAL_SERVER_ERROR', details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service Unavailable', details?: unknown) {
    super(message, 503, 'SERVICE_UNAVAILABLE', details);
  }
}
