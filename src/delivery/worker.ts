import { createHash } from "node:crypto";

import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import type { DeliveryOutbox, DeliveryRow, OutboxHealth } from "./outbox.js";

export const RECEIPT_TAG_PREFIX = "openclaw:idem-";
const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

type DeliveryLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
};

type RetrieveResponse = {
  mode?: string;
  limit?: number;
  warnings?: unknown;
  results?: Array<{ object_id?: unknown }>;
};

type ReadbackResponse = {
  object_id?: unknown;
  id?: unknown;
  namespace?: unknown;
  content?: unknown;
  tags?: unknown;
};

export class DeliveryWorker {
  readonly #client: MusubiClient;
  readonly #config: MusubiConfig;
  readonly #outbox: DeliveryOutbox;
  readonly #logger: DeliveryLogger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #draining = false;
  #stopped = true;
  #pruneTicks = 0;
  #abortController = new AbortController();

  constructor(options: {
    client: MusubiClient;
    config: MusubiConfig;
    outbox: DeliveryOutbox;
    logger: DeliveryLogger;
  }) {
    this.#client = options.client;
    this.#config = options.config;
    this.#outbox = options.outbox;
    this.#logger = options.logger;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#abortController = new AbortController();
    const recovered = this.#outbox.recoverOrphans();
    if (recovered > 0) {
      this.#logger.warn(`musubi: recovered ${recovered} orphaned outbox lease(s)`);
    }
    void this.drainOnce();
    this.#timer = setInterval(() => void this.drainOnce(), 1000);
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.#stopped = true;
    this.#abortController.abort();
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.#draining && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  kick(): void {
    if (!this.#stopped) void this.drainOnce();
  }

  health(): OutboxHealth {
    return this.#outbox.health();
  }

  async awaitTerminal(rowId: number, timeoutMs = 1500): Promise<DeliveryRow | undefined> {
    const deadline = Date.now() + timeoutMs;
    this.kick();
    while (Date.now() < deadline) {
      const row = this.#outbox.row(rowId);
      if (!row || row.state === "verified" || row.state === "dead") return row;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return this.#outbox.row(rowId);
  }

  async drainOnce(): Promise<void> {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    try {
      for (const row of this.#outbox.claimBatch()) {
        if (this.#stopped) break;
        await this.#deliver(row);
      }
      this.#pruneTicks += 1;
      if (this.#pruneTicks >= 300) {
        this.#pruneTicks = 0;
        this.#outbox.pruneVerified();
      }
    } catch (error) {
      this.#logger.error(`musubi: outbox worker failed — ${errorMessage(error)}`);
    } finally {
      this.#draining = false;
    }
  }

  async #deliver(row: DeliveryRow): Promise<void> {
    try {
      if (row.object_id) {
        await this.#verify(row, row.object_id);
        return;
      }

      const presence = resolvePresence(this.#config, {
        agentId: row.agent_id ?? undefined,
        strict: row.agent_id !== null,
      });
      if (row.attempts > 0) {
        const existing = await this.#findByReceipt(row, presence.token);
        if (existing) {
          this.#outbox.markAccepted(row.id, existing);
          await this.#verify(row, existing);
          return;
        }
      }
      const tags = parseTags(row.tags_json);
      const response = await this.#client.post<{ object_id?: unknown }>("/v1/episodic", {
        body: {
          namespace: row.namespace,
          content: row.content ?? "",
          importance: row.importance,
          tags: [...tags, `${RECEIPT_TAG_PREFIX}${row.idem_key}`],
        },
        idempotencyKey: row.idem_key,
        token: presence.token,
        signal: this.#abortController.signal,
      });
      const objectId = response?.object_id;
      if (typeof objectId !== "string" || objectId.length === 0) {
        this.#outbox.markFailed(row.id, "write returned no canonical object_id", false);
        return;
      }
      this.#outbox.markAccepted(row.id, objectId);
      await this.#verify(row, objectId);
    } catch (error) {
      const prefix =
        row.attempts > 0 && !row.object_id ? "delivery/receipt lookup failed" : "delivery failed";
      this.#outbox.markFailed(row.id, `${prefix}: ${errorMessage(error)}`, isRetryable(error));
    }
  }

  async #findByReceipt(row: DeliveryRow, token: string): Promise<string | undefined> {
    const response = await this.#client.post<RetrieveResponse>("/v1/retrieve", {
      body: {
        namespace: row.namespace,
        mode: "recent",
        limit: 50,
        tags: [`${RECEIPT_TAG_PREFIX}${row.idem_key}`],
        state_filter: [...RECALL_STATES],
      },
      token,
      signal: this.#abortController.signal,
    });
    if (
      response?.mode !== "recent" ||
      response.limit !== 50 ||
      !Array.isArray(response.results) ||
      !Array.isArray(response.warnings) ||
      response.warnings.length > 0
    ) {
      throw new Error("receipt lookup returned an invalid or degraded envelope");
    }
    const first = response.results[0];
    if (!first) return undefined;
    if (typeof first.object_id !== "string" || first.object_id.length === 0) {
      throw new Error("receipt lookup returned a row without object_id");
    }
    return first.object_id;
  }

  async #verify(row: DeliveryRow, objectId: string): Promise<void> {
    let presence: PresenceContext;
    try {
      presence = resolvePresence(this.#config, {
        agentId: row.agent_id ?? undefined,
        strict: row.agent_id !== null,
      });
      const got = await this.#client.getWithQuery<ReadbackResponse>(
        `/v1/episodic/${encodeURIComponent(objectId)}`,
        { namespace: row.namespace },
        { token: presence.token, signal: this.#abortController.signal },
      );
      const gotId = got.object_id ?? got.id;
      const gotSha = sha256(typeof got.content === "string" ? got.content : "");
      const mismatches: string[] = [];
      if (gotId !== objectId) mismatches.push("object_id");
      if (got.namespace !== row.namespace) mismatches.push("namespace");
      if (gotSha !== row.content_sha256) mismatches.push("content_sha256");
      if (mismatches.length > 0) {
        // A content-only mismatch is the signature of a server-side
        // dedup-merge, not a corrupted delivery: the episodic plane
        // merges factually-compatible near-duplicates (cosine + a
        // casefolded/whitespace-normalized compare) into the EXISTING
        // row under a longer-wins content policy, unions the tags, and
        // returns the existing object. The merged row therefore carries
        // OUR receipt tag while its content legitimately differs from
        // what we submitted. Byte-exact hashing can never accept that,
        // so verify identity through the receipt tag instead of
        // dead-lettering a delivery the server accepted.
        if (this.#isDedupMerge(row, mismatches, got)) {
          this.#outbox.markVerified(row.id, objectId);
          this.#logger.info(
            `musubi: verified ${row.namespace}/${objectId} via server dedup-merge ` +
              "(canonical content differs from submission; receipt tag present)",
          );
          return;
        }
        this.#outbox.markFailed(
          row.id,
          `readback identity mismatch: ${mismatches.join(", ")}`,
          false,
        );
        return;
      }
      this.#outbox.markVerified(row.id, objectId);
      this.#logger.debug?.(`musubi: verified ${row.namespace}/${objectId}`);
    } catch (error) {
      const grace404 = error instanceof MusubiError && error.status === 404 && row.attempts < 5;
      this.#outbox.markFailed(
        row.id,
        `readback failed: ${errorMessage(error)}`,
        grace404 || isRetryable(error),
      );
    }
  }

  /**
   * True iff a readback mismatch is explained by a server dedup-merge:
   * object_id and namespace both verified, ONLY the content hash
   * differs, and the readback row's tags include this delivery's
   * receipt tag (proof the server unioned our write into that row).
   */
  #isDedupMerge(row: DeliveryRow, mismatches: readonly string[], got: ReadbackResponse): boolean {
    if (mismatches.length !== 1 || mismatches[0] !== "content_sha256") return false;
    if (!Array.isArray(got.tags)) return false;
    const receiptTag = `${RECEIPT_TAG_PREFIX}${row.idem_key}`;
    return got.tags.some((tag) => tag === receiptTag);
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof MusubiError)) return true;
  return (
    error.code === "network" ||
    error.code === "timeout" ||
    error.code === "server" ||
    error.code === "rate-limit"
  );
}

function parseTags(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("outbox tags_json is not a string array");
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
