/**
 * Bounded dedup set with TTL.
 *
 * Per `docs/api-contract.md` §SSE rule 3: keep the last 1000 `object_id`s
 * or a 1-hour TTL, whichever bound is hit first. Replay on reconnect can
 * overlap with in-flight delivery; the set ensures we never deliver the
 * same thought twice in-process.
 *
 * Implementation: a `Map<id, insertedAt>` with insertion-order eviction.
 * `Map` preserves insertion order so the oldest key is always the first
 * iterated, giving O(1) eviction without a separate LRU list.
 */

export type BoundedDedupSetOptions = {
  readonly maxSize?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

export const DEFAULT_DEDUP_MAX_SIZE = 1_000;
export const DEFAULT_DEDUP_TTL_MS = 60 * 60 * 1_000; // 1 hour

export class BoundedDedupSet {
  readonly #maxSize: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #seen: Map<string, number>;

  constructor(options: BoundedDedupSetOptions = {}) {
    this.#maxSize = options.maxSize ?? DEFAULT_DEDUP_MAX_SIZE;
    this.#ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#seen = new Map();
  }

  has(id: string): boolean {
    const insertedAt = this.#seen.get(id);
    if (insertedAt === undefined) return false;
    if (this.#isExpired(insertedAt)) {
      this.#seen.delete(id);
      return false;
    }
    return true;
  }

  /** Returns `true` if the id was newly added; `false` if already present. */
  add(id: string): boolean {
    if (this.has(id)) return false;
    this.#seen.set(id, this.#now());
    this.#evictIfOverCap();
    return true;
  }

  size(): number {
    return this.#seen.size;
  }

  #isExpired(insertedAt: number): boolean {
    return this.#now() - insertedAt > this.#ttlMs;
  }

  #evictIfOverCap(): void {
    while (this.#seen.size > this.#maxSize) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
  }
}
