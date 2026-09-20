import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DeliveryState = "pending" | "inflight" | "accepted" | "verified" | "dead";

export type EnqueueDelivery = {
  readonly idempotencyKey: string;
  readonly contentSha256: string;
  readonly namespace: string;
  readonly agentId?: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly importance: number;
  readonly sourceRef: string;
};

export type DeliveryRow = {
  readonly id: number;
  readonly idem_key: string;
  readonly content_sha256: string;
  readonly namespace: string;
  readonly agent_id: string | null;
  readonly content: string | null;
  readonly tags_json: string;
  readonly importance: number;
  readonly source_ref: string;
  readonly created_at_ms: number;
  readonly attempts: number;
  readonly next_try_at_ms: number;
  readonly leased_at_ms: number | null;
  readonly lease_owner: string | null;
  readonly last_error: string | null;
  readonly consecutive_failures: number;
  readonly verified_at_ms: number | null;
  readonly died_at_ms: number | null;
  readonly state: DeliveryState;
  readonly object_id: string | null;
};

export type OutboxHealth = {
  readonly pending: number;
  readonly dead: number;
  /** Dead rows that died inside {@link DEAD_ALERT_WINDOW_MS}; drives `degraded`. */
  readonly recentDead: number;
  readonly oldestPendingAgeMs: number;
  readonly consecutiveFailures: number;
  readonly lastVerifiedAtMs: number | null;
  readonly degraded: boolean;
};

const LEASE_TTL_MS = 120_000;
const VERIFIED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a dead row keeps the provider marked `degraded`.
 *
 * Dead rows are retained for 30 days so an operator can still inspect what
 * failed, but a permanent `degraded` flag is a signal nobody acts on: a
 * single delivery that died last month would otherwise pin `/musubi-status`
 * to "degraded" forever with no way to clear it short of editing SQLite.
 * Health reports the full `dead` count either way — only the alarm is windowed.
 */
const DEAD_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Durable delivery ledger. A passive capture is accepted only after this
 * database commits it; network delivery is always asynchronous.
 */
export class DeliveryOutbox {
  readonly #db: DatabaseSync;
  readonly #owner = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=FULL");
    this.#db.exec("PRAGMA busy_timeout=15000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idem_key TEXT NOT NULL UNIQUE,
        content_sha256 TEXT NOT NULL,
        namespace TEXT NOT NULL,
        agent_id TEXT,
        content TEXT,
        tags_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        source_ref TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_try_at_ms INTEGER NOT NULL DEFAULT 0,
        leased_at_ms INTEGER,
        lease_owner TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        verified_at_ms INTEGER,
        died_at_ms INTEGER,
        state TEXT NOT NULL DEFAULT 'pending',
        object_id TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_delivery_outbox_ready
        ON delivery_outbox(state, next_try_at_ms);
    `);
    this.#migrate();
  }

  /**
   * Additive, idempotent column migrations. `CREATE TABLE IF NOT EXISTS`
   * leaves an existing ledger untouched, so a column added after 2.0.7 has
   * to be patched onto databases already on disk.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare("PRAGMA table_info(delivery_outbox)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("died_at_ms")) {
      this.#db.exec("ALTER TABLE delivery_outbox ADD COLUMN died_at_ms INTEGER");
      // Rows that died before this column existed get a timestamp now rather
      // than NULL, so they age out of the alert window instead of being
      // treated as having died at the epoch (or never aging out at all).
      this.#db
        .prepare("UPDATE delivery_outbox SET died_at_ms = ? WHERE state = 'dead'")
        .run(Date.now());
    }
  }

  enqueue(item: EnqueueDelivery): DeliveryRow {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO delivery_outbox (
          idem_key, content_sha256, namespace, agent_id, content, tags_json,
          importance, source_ref, created_at_ms, next_try_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(idem_key) DO NOTHING`,
      )
      .run(
        item.idempotencyKey,
        item.contentSha256,
        item.namespace,
        item.agentId ?? null,
        item.content,
        JSON.stringify(item.tags),
        item.importance,
        item.sourceRef,
        now,
      );
    const row = this.rowForIdempotency(item.idempotencyKey);
    if (!row) {
      throw new Error("musubi: outbox enqueue committed but row could not be read back");
    }
    if (
      row.content_sha256 !== item.contentSha256 ||
      row.namespace !== item.namespace ||
      row.source_ref !== item.sourceRef ||
      row.agent_id !== (item.agentId ?? null) ||
      row.tags_json !== JSON.stringify(item.tags) ||
      row.importance !== item.importance
    ) {
      throw new Error(
        `musubi: idempotency collision for ${item.idempotencyKey}; existing payload differs`,
      );
    }
    return row;
  }

  row(id: number): DeliveryRow | undefined {
    return this.#db.prepare("SELECT * FROM delivery_outbox WHERE id = ?").get(id) as
      | DeliveryRow
      | undefined;
  }

  rowForIdempotency(idempotencyKey: string): DeliveryRow | undefined {
    return this.#db
      .prepare("SELECT * FROM delivery_outbox WHERE idem_key = ?")
      .get(idempotencyKey) as DeliveryRow | undefined;
  }

  recoverOrphans(now = Date.now()): number {
    const inflight = this.#db
      .prepare(
        "SELECT id, lease_owner, leased_at_ms, object_id FROM delivery_outbox WHERE state = 'inflight'",
      )
      .all() as Array<Pick<DeliveryRow, "id" | "lease_owner" | "leased_at_ms" | "object_id">>;
    let recovered = 0;
    const update = this.#db.prepare(
      `UPDATE delivery_outbox
       SET state = ?, leased_at_ms = NULL, lease_owner = NULL, attempts = attempts + 1
       WHERE id = ? AND state = 'inflight'`,
    );
    for (const row of inflight) {
      const expired = row.leased_at_ms === null || row.leased_at_ms < now - LEASE_TTL_MS;
      if (!expired && ownerIsAlive(row.lease_owner)) continue;
      update.run(row.object_id ? "accepted" : "pending", row.id);
      recovered += 1;
    }
    return recovered;
  }

  claimBatch(limit = 20, now = Date.now()): DeliveryRow[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE delivery_outbox
           SET state = CASE WHEN object_id IS NULL THEN 'pending' ELSE 'accepted' END,
               leased_at_ms = NULL, lease_owner = NULL, attempts = attempts + 1
           WHERE state = 'inflight' AND (leased_at_ms IS NULL OR leased_at_ms < ?)`,
        )
        .run(now - LEASE_TTL_MS);
      const ids = (
        this.#db
          .prepare(
            `SELECT id FROM delivery_outbox
             WHERE state IN ('pending', 'accepted') AND next_try_at_ms <= ?
             ORDER BY id LIMIT ?`,
          )
          .all(now, limit) as Array<{ id: number }>
      ).map((row) => row.id);
      if (ids.length === 0) {
        this.#db.exec("COMMIT");
        return [];
      }
      const placeholders = ids.map(() => "?").join(",");
      this.#db
        .prepare(
          `UPDATE delivery_outbox SET state = 'inflight', leased_at_ms = ?, lease_owner = ?
           WHERE id IN (${placeholders}) AND state IN ('pending', 'accepted')`,
        )
        .run(now, this.#owner, ...ids);
      const rows = this.#db
        .prepare(
          `SELECT * FROM delivery_outbox
           WHERE id IN (${placeholders}) AND state = 'inflight' AND lease_owner = ?
           ORDER BY id`,
        )
        .all(...ids, this.#owner) as DeliveryRow[];
      this.#db.exec("COMMIT");
      return rows;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  markAccepted(id: number, objectId: string): void {
    this.#db
      .prepare(
        `UPDATE delivery_outbox
         SET state = 'accepted', object_id = ?, leased_at_ms = NULL, lease_owner = NULL,
             last_error = NULL
         WHERE id = ?`,
      )
      .run(objectId, id);
  }

  markVerified(id: number, objectId: string, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE delivery_outbox
         SET state = 'verified', object_id = ?, content = NULL, last_error = NULL,
             consecutive_failures = 0, leased_at_ms = NULL, lease_owner = NULL,
             verified_at_ms = ?
         WHERE id = ?`,
      )
      .run(objectId, now, id);
  }

  /**
   * @param retryAfterMs Server-requested wait (from a 429 `Retry-After` the
   *   client declined to sleep on in-band). Honored verbatim when it exceeds
   *   the computed backoff, so a long rate-limit window is waited out here —
   *   durably, and without blocking the worker's drain loop.
   */
  markFailed(
    id: number,
    error: string,
    retryable: boolean,
    now = Date.now(),
    retryAfterMs?: number,
  ): void {
    const row = this.row(id);
    if (!row) return;
    if (!retryable) {
      this.#db
        .prepare(
          `UPDATE delivery_outbox
           SET state = 'dead', last_error = ?, consecutive_failures = consecutive_failures + 1,
               leased_at_ms = NULL, lease_owner = NULL, died_at_ms = ?
           WHERE id = ?`,
        )
        .run(error.slice(0, 500), now, id);
      return;
    }
    const attempts = row.attempts + 1;
    const base = Math.min(300_000, 2 ** Math.min(attempts, 8) * 1000);
    const backoff = deterministicJitter(row.idem_key, attempts, base);
    const jitter =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
        ? Math.max(backoff, Math.min(retryAfterMs, DEAD_RETENTION_MS))
        : backoff;
    this.#db
      .prepare(
        `UPDATE delivery_outbox
         SET state = ?, attempts = ?, next_try_at_ms = ?, last_error = ?,
             consecutive_failures = consecutive_failures + 1,
             leased_at_ms = NULL, lease_owner = NULL
         WHERE id = ?`,
      )
      .run(row.object_id ? "accepted" : "pending", attempts, now + jitter, error.slice(0, 500), id);
  }

  /**
   * Return a leased row to its ready state without recording a failure.
   *
   * Used when delivery was cancelled rather than rejected (process shutdown):
   * charging a `consecutive_failures` increment for an orderly stop would
   * walk a healthy provider toward `degraded` across a few restarts.
   */
  markDeferred(id: number, now = Date.now()): void {
    const row = this.row(id);
    if (!row) return;
    this.#db
      .prepare(
        `UPDATE delivery_outbox
         SET state = ?, next_try_at_ms = ?, leased_at_ms = NULL, lease_owner = NULL
         WHERE id = ? AND state = 'inflight'`,
      )
      .run(row.object_id ? "accepted" : "pending", now, id);
  }

  health(now = Date.now()): OutboxHealth {
    const aggregate = this.#db
      .prepare(
        `SELECT
          SUM(CASE WHEN state IN ('pending','inflight','accepted') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN state = 'dead' THEN 1 ELSE 0 END) AS dead,
          SUM(CASE WHEN state = 'dead' AND (died_at_ms IS NULL OR died_at_ms >= ?)
                   THEN 1 ELSE 0 END) AS recent_dead,
          MIN(CASE WHEN state IN ('pending','inflight','accepted') THEN created_at_ms END) AS oldest,
          MAX(CASE WHEN state IN ('pending','inflight','accepted') THEN consecutive_failures ELSE 0 END) AS failures,
          MAX(verified_at_ms) AS last_verified
         FROM delivery_outbox`,
      )
      .get(now - DEAD_ALERT_WINDOW_MS) as {
      pending: number | null;
      dead: number | null;
      recent_dead: number | null;
      oldest: number | null;
      failures: number | null;
      last_verified: number | null;
    };
    const pending = aggregate.pending ?? 0;
    const dead = aggregate.dead ?? 0;
    const recentDead = aggregate.recent_dead ?? 0;
    const oldestPendingAgeMs = aggregate.oldest === null ? 0 : Math.max(0, now - aggregate.oldest);
    const consecutiveFailures = aggregate.failures ?? 0;
    return {
      pending,
      dead,
      recentDead,
      oldestPendingAgeMs,
      consecutiveFailures,
      lastVerifiedAtMs: aggregate.last_verified,
      // Windowed on purpose: see DEAD_ALERT_WINDOW_MS. `dead` stays in the
      // payload so an operator can still see the full history.
      degraded: recentDead > 0 || consecutiveFailures >= 3 || oldestPendingAgeMs > 300_000,
    };
  }

  /**
   * Drop rows past their retention. Verified rows carry no plaintext (it is
   * cleared at verification) and go after 7 days; dead rows keep their
   * payload for post-mortem and go after 30.
   */
  prune(now = Date.now()): number {
    const verified = this.#db
      .prepare("DELETE FROM delivery_outbox WHERE state = 'verified' AND verified_at_ms < ?")
      .run(now - VERIFIED_RETENTION_MS).changes;
    const dead = this.#db
      .prepare(
        "DELETE FROM delivery_outbox WHERE state = 'dead' AND died_at_ms IS NOT NULL AND died_at_ms < ?",
      )
      .run(now - DEAD_RETENTION_MS).changes;
    return Number(verified) + Number(dead);
  }

  /** @deprecated Use {@link prune}, which also retires aged dead rows. */
  pruneVerified(now = Date.now()): number {
    return this.prune(now);
  }

  close(): void {
    this.#db.close();
  }
}

function ownerIsAlive(owner: string | null): boolean {
  if (!owner) return false;
  const pid = Number(owner.split("-", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function deterministicJitter(key: string, attempts: number, base: number): number {
  let hash = 2166136261;
  for (const char of `${key}:${attempts}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.max(250, Math.floor(((hash >>> 0) / 0xffffffff) * base));
}
