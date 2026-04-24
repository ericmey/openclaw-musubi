import type { MusubiError } from "./errors.js";
import {
  AuthError,
  ClientError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
} from "./errors.js";
import { DEFAULT_RETRY_POLICY, nextDelayMs, type RetryPolicy } from "./retry.js";
import type { ClientOptions, FetchLike, HttpMethod, RequestOptions } from "./types.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../config.js";

const AUTH_HEADER = "Authorization";
const REQUEST_ID_HEADER = "X-Request-Id";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const CONTENT_TYPE_HEADER = "Content-Type";
const JSON_CONTENT_TYPE = "application/json";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultIdGenerator = (): string => crypto.randomUUID();

/**
 * Typed HTTP client for the Musubi canonical API.
 *
 * Constructed with a base URL and bearer token; each call adds a fresh
 * `X-Request-Id` and, on POST writes, a stable `Idempotency-Key` that is
 * reused across retries so a retried write never double-posts.
 *
 * Retry behavior follows `docs/api-contract.md`:
 * - Network errors and 5xx responses are retried with exponential backoff.
 * - 429 honors `Retry-After` (seconds).
 * - 401/403/404 and other 4xx are never retried.
 * - All retries bounded by `retry.maxAttempts` (default 5).
 */
export class MusubiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #retry: RetryPolicy;
  readonly #requestTimeoutMs: number;
  readonly #generateRequestId: () => string;
  readonly #generateIdempotencyKey: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: ClientOptions) {
    const normalized = options.baseUrl.replace(/\/+$/, "");
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      throw new TypeError(`MusubiClient baseUrl must be http(s):// (got "${options.baseUrl}")`);
    }
    this.#baseUrl = normalized;
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) };
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#generateRequestId = options.generateRequestId ?? defaultIdGenerator;
    this.#generateIdempotencyKey = options.generateIdempotencyKey ?? defaultIdGenerator;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  /** Convenience GET with query params — same as {@link get} but types the query bag. */
  getWithQuery<T = unknown>(
    path: string,
    query: NonNullable<RequestOptions["query"]>,
    options?: Omit<RequestOptions, "query">,
  ): Promise<T> {
    return this.request<T>("GET", path, { ...options, query });
  }

  post<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  patch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }

  delete<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const requestId = this.#generateRequestId();
    const idempotencyKey =
      method === "POST" ? (options.idempotencyKey ?? this.#generateIdempotencyKey()) : undefined;

    const url = this.#buildUrl(path, options.query);
    const hasBody = options.body !== undefined;
    const headers = this.#buildHeaders(requestId, idempotencyKey, hasBody, options.token);
    const body = hasBody ? JSON.stringify(options.body) : undefined;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;

    for (let attempt = 0; ; attempt++) {
      const attemptResult = await this.#attemptOnce(
        method,
        url,
        headers,
        body,
        requestId,
        path,
        timeoutMs,
        options.signal,
      );

      if (attemptResult.kind === "ok") {
        return attemptResult.value as T;
      }

      const error = attemptResult.error;
      const isRetryable =
        error.code === "network" || error.code === "server" || error.code === "rate-limit";
      const hasAttemptsLeft = attempt < this.#retry.maxAttempts - 1;

      if (!isRetryable || !hasAttemptsLeft) {
        throw error;
      }

      const delayMs =
        error instanceof RateLimitError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : nextDelayMs(attempt, this.#retry, this.#random);

      await this.#sleep(delayMs);
    }
  }

  async #attemptOnce(
    method: HttpMethod,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    requestId: string,
    path: string,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<{ kind: "ok"; value: unknown } | { kind: "err"; error: MusubiError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortHandler = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (rawError) {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortHandler);
      }
      const cause = rawError instanceof Error ? rawError : undefined;
      const isAbort = cause?.name === "AbortError";
      const error = isAbort
        ? new TimeoutError(timeoutMs, { requestId, cause })
        : new NetworkError(cause?.message ?? "Network request failed", { requestId, cause });
      // Timeouts and network errors are both retried as "network" class.
      // The TimeoutError subclass keeps the distinction for callers/logging.
      const retryableError =
        error instanceof TimeoutError
          ? new NetworkError(error.message, { requestId, cause, status: undefined })
          : error;
      return { kind: "err", error: retryableError };
    }
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortHandler);
    }

    if (response.ok) {
      const value = await this.#parseBody(response);
      return { kind: "ok", value };
    }

    const error = await this.#mapErrorResponse(response, requestId, path);
    return { kind: "err", error };
  }

  #buildUrl(path: string, query: RequestOptions["query"]): string {
    const root = this.#baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const base = `${root}${normalizedPath}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs.length > 0 ? `${base}?${qs}` : base;
  }

  #buildHeaders(
    requestId: string,
    idempotencyKey: string | undefined,
    hasBody: boolean,
    tokenOverride?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      [AUTH_HEADER]: `Bearer ${tokenOverride ?? this.#token}`,
      [REQUEST_ID_HEADER]: requestId,
      Accept: JSON_CONTENT_TYPE,
    };
    if (hasBody) {
      headers[CONTENT_TYPE_HEADER] = JSON_CONTENT_TYPE;
    }
    if (idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    }
    return headers;
  }

  async #parseBody(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    const contentLength = response.headers.get("content-length");
    if (contentLength === "0") return undefined;
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async #mapErrorResponse(
    response: Response,
    requestId: string,
    path: string,
  ): Promise<MusubiError> {
    const status = response.status;
    const bodyText = await response.text().catch(() => "");

    if (status === 401 || status === 403) {
      return new AuthError(status as 401 | 403, { requestId });
    }
    if (status === 404) {
      return new NotFoundError(path, { requestId });
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      return new RateLimitError(retryAfterMs, { requestId });
    }
    if (status >= 500) {
      return new ServerError(status, truncate(bodyText), { requestId });
    }
    return new ClientError(status, truncate(bodyText), { requestId });
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function truncate(value: string, max = 200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
