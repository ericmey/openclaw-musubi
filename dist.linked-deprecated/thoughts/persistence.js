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
export class InMemoryLastEventIdStore {
    #value;
    constructor(initial) {
        this.#value = initial;
    }
    async read() {
        return this.#value;
    }
    async write(id) {
        this.#value = id;
    }
    async clear() {
        this.#value = undefined;
    }
}
//# sourceMappingURL=persistence.js.map