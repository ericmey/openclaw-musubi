import { describe, expect, it, vi } from "vitest";

import type { DeliveryRow } from "../../src/delivery/outbox.js";
import { createRememberTool } from "../../src/tools/remember.js";

function row(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: 1,
    idem_key: "openclaw-remember:call-1",
    content_sha256: "sha",
    namespace: "aoi/command-chair/episodic",
    agent_id: "aoi",
    content: "note",
    tags_json: "[]",
    importance: 7,
    source_ref: "call-1",
    created_at_ms: 1,
    attempts: 0,
    next_try_at_ms: 0,
    leased_at_ms: null,
    lease_owner: null,
    last_error: null,
    consecutive_failures: 0,
    verified_at_ms: null,
    died_at_ms: null,
    state: "pending",
    object_id: null,
    write_dedup_merge: null,
    ...overrides,
  };
}

describe("createRememberTool", () => {
  it("returns verified only after canonical delivery verification", async () => {
    const enqueueExplicit = vi.fn(() => row());
    const awaitTerminal = vi.fn(async () =>
      row({ state: "verified", object_id: "obj-1", verified_at_ms: 2 }),
    );
    const tool = createRememberTool({
      delivery: { enqueueExplicit, awaitTerminal },
      agentId: "aoi",
    });
    const result = await tool.definition.execute("call-1", {
      content: "important",
      importance: 9,
      topics: ["decision"],
    });
    expect(enqueueExplicit).toHaveBeenCalledWith({
      agentId: "aoi",
      toolCallId: "call-1",
      content: "important",
      importance: 9,
      topics: ["decision"],
      idempotencyKey: "openclaw-remember:call-1",
    });
    expect(result.content[0]?.text).toContain("Verified in Musubi");
    expect(result.content[0]?.text).toContain("obj-1");
  });

  it("truthfully reports durable queued state rather than remembered", async () => {
    const pending = row();
    const tool = createRememberTool({
      delivery: {
        enqueueExplicit: () => pending,
        awaitTerminal: async () => pending,
      },
    });
    const result = await tool.definition.execute("call-1", { content: "note" });
    expect(result.content[0]?.text).toContain("Queued durably");
    expect(result.content[0]?.text).toContain("not yet verified");
    expect(result.content[0]?.text).not.toContain("Remembered");
  });

  it("surfaces dead delivery as a tool error", async () => {
    const dead = row({ state: "dead", last_error: "401 auth" });
    const tool = createRememberTool({
      delivery: {
        enqueueExplicit: () => row(),
        awaitTerminal: async () => dead,
      },
    });
    const result = await tool.definition.execute("call-1", { content: "note" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("401 auth");
  });

  it("test_dead_delivery_surfaces_partial_object_id_when_readback_failed_after_acceptance", async () => {
    // A row that reached the `accepted` state and only failed on the
    // canonical readback carries an `object_id` even when `state=dead`.
    // Surfacing it lets the operator correlate the tool's failure message
    // with a server-side object (e.g. via `/musubi-status`).
    const dead = row({
      state: "dead",
      object_id: "obj-partial-1",
      last_error: "readback identity mismatch: content_sha256",
    });
    const tool = createRememberTool({
      delivery: {
        enqueueExplicit: () => row(),
        awaitTerminal: async () => dead,
      },
    });
    const result = await tool.definition.execute("call-1", { content: "note" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("obj-partial-1");
    expect(result.content[0]?.text).toContain("readback identity mismatch");
  });

  it("test_dead_delivery_without_object_id_does_not_emit_a_partial_hint", async () => {
    // Negative path: a row that failed before acceptance (e.g. 401) has
    // no `object_id`. The error message must NOT include a misleading
    // `partial object_id=undefined` hint.
    const dead = row({ state: "dead", object_id: null, last_error: "401 auth" });
    const tool = createRememberTool({
      delivery: {
        enqueueExplicit: () => row(),
        awaitTerminal: async () => dead,
      },
    });
    const result = await tool.definition.execute("call-1", { content: "note" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/partial object_id/u);
  });

  it("does not claim a queue write when local persistence fails", async () => {
    const tool = createRememberTool({
      delivery: {
        enqueueExplicit: () => {
          throw new Error("disk full");
        },
        awaitTerminal: async () => undefined,
      },
    });
    const result = await tool.definition.execute("call-1", { content: "note" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("was not queued");
  });
});
