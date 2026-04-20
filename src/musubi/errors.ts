/**
 * Typed error hierarchy raised by the Musubi HTTP client.
 *
 * Callers can either `instanceof` a specific subclass or switch on `code` —
 * the two are kept in lockstep. Status (when applicable) and the request id
 * that triggered the failure are always attached so logs trace cleanly.
 *
 * The taxonomy mirrors `docs/api-contract.md` §HTTP "Error taxonomy":
 * - `NetworkError`     — connection failure, DNS failure, abort/timeout.
 * - `AuthError`        — 401 or 403; never retried.
 * - `NotFoundError`    — 404; never retried.
 * - `RateLimitError`   — 429; retried with `Retry-After`.
 * - `ClientError`      — 4xx other than the above; never retried.
 * - `ServerError`      — 5xx after the retry policy is exhausted.
 */

export type MusubiErrorCode =
  | "network"
  | "timeout"
  | "auth"
  | "not-found"
  | "rate-limit"
  | "client"
  | "server";

export type MusubiErrorOptions = {
  status?: number;
  requestId?: string;
  cause?: unknown;
};

export class MusubiError extends Error {
  readonly code: MusubiErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, code: MusubiErrorCode, options: MusubiErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "MusubiError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export class NetworkError extends MusubiError {
  constructor(message: string, options: MusubiErrorOptions = {}) {
    super(message, "network", options);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends MusubiError {
  constructor(timeoutMs: number, options: MusubiErrorOptions = {}) {
    super(`Request exceeded ${timeoutMs}ms timeout`, "timeout", options);
    this.name = "TimeoutError";
  }
}

export class AuthError extends MusubiError {
  constructor(status: 401 | 403, options: MusubiErrorOptions = {}) {
    super(
      status === 401
        ? "Authentication required (401)"
        : "Forbidden — token scope insufficient (403)",
      "auth",
      { ...options, status },
    );
    this.name = "AuthError";
  }
}

export class NotFoundError extends MusubiError {
  constructor(path: string, options: MusubiErrorOptions = {}) {
    super(`Not found (404): ${path}`, "not-found", { ...options, status: 404 });
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends MusubiError {
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined, options: MusubiErrorOptions = {}) {
    super("Rate limited (429)", "rate-limit", { ...options, status: 429 });
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ClientError extends MusubiError {
  constructor(status: number, message: string, options: MusubiErrorOptions = {}) {
    super(`Client error (${status}): ${message}`, "client", { ...options, status });
    this.name = "ClientError";
  }
}

export class ServerError extends MusubiError {
  constructor(status: number, message: string, options: MusubiErrorOptions = {}) {
    super(`Server error (${status}): ${message}`, "server", { ...options, status });
    this.name = "ServerError";
  }
}
