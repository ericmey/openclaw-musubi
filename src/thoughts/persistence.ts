/**
 * Last-Event-ID persistence abstraction.
 *
 * Per `docs/api-contract.md` §SSE rule 2: the consumer persists the most
 * recent acknowledged `id` so a service-worker restart resumes from where
 * it left off rather than replaying the entire thoughts plane.
 *
 * The interface is async-by-shape so a real implementation can hit
 * IndexedDB / `chrome.storage.local` / a file / OpenClaw's plugin runtime
 * store without forcing the consumer to know which. This module ships
 * an `InMemoryLastEventIdStore` for tests; production consumers inject
 * a runtime-backed store.
 */

export type LastEventIdStore = {
  read(): Promise<string | undefined>;
  write(id: string): Promise<void>;
  clear(): Promise<void>;
};

export class InMemoryLastEventIdStore implements LastEventIdStore {
  #value: string | undefined;

  constructor(initial?: string) {
    this.#value = initial;
  }

  async read(): Promise<string | undefined> {
    return this.#value;
  }

  async write(id: string): Promise<void> {
    this.#value = id;
  }

  async clear(): Promise<void> {
    this.#value = undefined;
  }
}
