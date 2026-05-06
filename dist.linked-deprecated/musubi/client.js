import { AuthError, ClientError, NetworkError, NotFoundError, RateLimitError, ServerError, TimeoutError, } from "./errors.js";
import { DEFAULT_RETRY_POLICY, nextDelayMs } from "./retry.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../config.js";
const AUTH_HEADER = "Authorization";
const REQUEST_ID_HEADER = "X-Request-Id";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const CONTENT_TYPE_HEADER = "Content-Type";
const JSON_CONTENT_TYPE = "application/json";
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultIdGenerator = () => crypto.randomUUID();
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
    #baseUrl;
    #token;
    #fetch;
    #retry;
    #requestTimeoutMs;
    #generateRequestId;
    #generateIdempotencyKey;
    #sleep;
    #random;
    constructor(options) {
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
    get(path, options = {}) {
        return this.request("GET", path, options);
    }
    /** Convenience GET with query params — same as {@link get} but types the query bag. */
    getWithQuery(path, query, options) {
        return this.request("GET", path, { ...options, query });
    }
    post(path, options = {}) {
        return this.request("POST", path, options);
    }
    patch(path, options = {}) {
        return this.request("PATCH", path, options);
    }
    delete(path, options = {}) {
        return this.request("DELETE", path, options);
    }
    async request(method, path, options = {}) {
        const requestId = this.#generateRequestId();
        const idempotencyKey = method === "POST" ? (options.idempotencyKey ?? this.#generateIdempotencyKey()) : undefined;
        const url = this.#buildUrl(path, options.query);
        const hasBody = options.body !== undefined;
        const headers = this.#buildHeaders(requestId, idempotencyKey, hasBody, options.token);
        const body = hasBody ? JSON.stringify(options.body) : undefined;
        const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
        for (let attempt = 0;; attempt++) {
            const attemptResult = await this.#attemptOnce(method, url, headers, body, requestId, path, timeoutMs, options.signal);
            if (attemptResult.kind === "ok") {
                return attemptResult.value;
            }
            const error = attemptResult.error;
            const isRetryable = error.code === "network" || error.code === "server" || error.code === "rate-limit";
            const hasAttemptsLeft = attempt < this.#retry.maxAttempts - 1;
            if (!isRetryable || !hasAttemptsLeft) {
                throw error;
            }
            const delayMs = error instanceof RateLimitError && error.retryAfterMs !== undefined
                ? error.retryAfterMs
                : nextDelayMs(attempt, this.#retry, this.#random);
            await this.#sleep(delayMs);
        }
    }
    async #attemptOnce(method, url, headers, body, requestId, path, timeoutMs, externalSignal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const abortHandler = () => controller.abort();
        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort();
            }
            else {
                externalSignal.addEventListener("abort", abortHandler, { once: true });
            }
        }
        let response;
        try {
            response = await this.#fetch(url, {
                method,
                headers,
                body,
                signal: controller.signal,
            });
        }
        catch (rawError) {
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
            const retryableError = error instanceof TimeoutError
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
    #buildUrl(path, query) {
        const root = this.#baseUrl;
        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        const base = `${root}${normalizedPath}`;
        if (!query)
            return base;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined)
                continue;
            params.append(key, String(value));
        }
        const qs = params.toString();
        return qs.length > 0 ? `${base}?${qs}` : base;
    }
    #buildHeaders(requestId, idempotencyKey, hasBody, tokenOverride) {
        const headers = {
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
    async #parseBody(response) {
        if (response.status === 204)
            return undefined;
        const contentLength = response.headers.get("content-length");
        if (contentLength === "0")
            return undefined;
        const text = await response.text();
        if (text.length === 0)
            return undefined;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    async #mapErrorResponse(response, requestId, path) {
        const status = response.status;
        const bodyText = await response.text().catch(() => "");
        if (status === 401 || status === 403) {
            return new AuthError(status, { requestId });
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
function parseRetryAfter(header) {
    if (header === null)
        return undefined;
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
function truncate(value, max = 200) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, max)}…`;
}
//# sourceMappingURL=client.js.map