export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function unauthorized(message = "Unauthorized."): HttpError {
  return new HttpError(401, "UNAUTHORIZED", message);
}

export function badRequest(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(400, code, message, details);
}

export function upstreamError(message: string, details?: unknown): HttpError {
  return new HttpError(502, "UPSTREAM_ERROR", message, details);
}
