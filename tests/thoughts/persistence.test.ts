import { describe, it, expect } from "vitest";
import { InMemoryLastEventIdStore } from "../../src/thoughts/persistence.js";

describe("InMemoryLastEventIdStore", () => {
  it("test_stream_persists_last_event_id_across_restart", async () => {
    // First "session" — write the last seen id.
    const session1 = new InMemoryLastEventIdStore();
    await session1.write("ksuid-abc-123");
    const persistedValue = await session1.read();

    // Simulate restart by constructing a new store seeded from the persisted value.
    // Production stores (IndexedDB / chrome.storage / file / KV) survive
    // process restarts; the in-memory variant simulates by passing the value
    // explicitly into the new instance.
    const session2 = new InMemoryLastEventIdStore(persistedValue);
    expect(await session2.read()).toBe("ksuid-abc-123");
  });

  it("returns undefined when nothing has been written", async () => {
    const store = new InMemoryLastEventIdStore();
    expect(await store.read()).toBeUndefined();
  });

  it("clear() resets the stored value", async () => {
    const store = new InMemoryLastEventIdStore("ksuid-x");
    await store.clear();
    expect(await store.read()).toBeUndefined();
  });

  it("write() overwrites the previous value", async () => {
    const store = new InMemoryLastEventIdStore("old");
    await store.write("new");
    expect(await store.read()).toBe("new");
  });
});
