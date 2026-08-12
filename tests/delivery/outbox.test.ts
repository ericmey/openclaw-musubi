import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryOutbox, type EnqueueDelivery } from "../../src/delivery/outbox.js";
import { DeliveryWorker } from "../../src/delivery/worker.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const root = mkdtempSync(join(tmpdir(), "musubi-outbox-"));
  roots.push(root);
  const path = join(root, "outbox.sqlite");
  return { path, outbox: new DeliveryOutbox(path) };
}

function item(overrides: Partial<EnqueueDelivery> = {}): EnqueueDelivery {
  const content = overrides.content ?? "durable note";
  return {
    idempotencyKey: "idem-1",
    contentSha256: createHash("sha256").update(content).digest("hex"),
    namespace: "aoi/command-chair/episodic",
    agentId: "aoi",
    content,
    tags: ["source:test"],
    importance: 7,
    sourceRef: "turn-1",
    ...overrides,
  };
}

const config: MusubiConfig = {
  core: { baseUrl: "https://musubi.test", token: "default", perAgentTokens: { aoi: "tok" } },
  presence: { defaultId: "aoi/command-chair", perAgent: { aoi: "aoi/command-chair" } },
};

const logger = { info() {}, warn() {}, error() {}, debug() {} };

describe("DeliveryOutbox", () => {
  it("commits and reads back one stable idempotency row", () => {
    const { outbox } = open();
    const first = outbox.enqueue(item());
    const second = outbox.enqueue(item());
    expect(second.id).toBe(first.id);
    expect(outbox.health().pending).toBe(1);
    outbox.close();
  });

  it("rejects one idempotency key bound to different content", () => {
    const { outbox } = open();
    outbox.enqueue(item());
    expect(() => outbox.enqueue(item({ content: "different" }))).toThrow(/idempotency collision/u);
    outbox.close();
  });

  it("rejects idempotency reuse when metadata changes under the same content", () => {
    const { outbox } = open();
    outbox.enqueue(item());
    expect(() => outbox.enqueue(item({ importance: 9 }))).toThrow(/idempotency collision/u);
    expect(() => outbox.enqueue(item({ tags: ["source:other"] }))).toThrow(
      /idempotency collision/u,
    );
    expect(() => outbox.enqueue(item({ agentId: "other" }))).toThrow(/idempotency collision/u);
    outbox.close();
  });

  it("survives close and reopen without losing pending delivery", () => {
    const { path, outbox } = open();
    const row = outbox.enqueue(item());
    outbox.close();
    const reopened = new DeliveryOutbox(path);
    expect(reopened.row(row.id)?.state).toBe("pending");
    reopened.close();
  });

  it("prunes verified payload content but retains identity", () => {
    const { outbox } = open();
    const row = outbox.enqueue(item());
    outbox.markVerified(row.id, "obj-1", 100);
    expect(outbox.row(row.id)).toMatchObject({
      state: "verified",
      object_id: "obj-1",
      content: null,
      content_sha256: item().contentSha256,
    });
    outbox.close();
  });
});

describe("DeliveryWorker", () => {
  it("persists accepted object id before canonical GET verification", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ object_id: "obj-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          object_id: "obj-1",
          namespace: item().namespace,
          content: item().content,
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 1000);
    expect(terminal).toMatchObject({ state: "verified", object_id: "obj-1", content: null });
    expect(calls).toEqual([
      "POST https://musubi.test/v1/episodic",
      "GET https://musubi.test/v1/episodic/obj-1?namespace=aoi%2Fcommand-chair%2Fepisodic",
    ]);
    await worker.stop();
    outbox.close();
  });

  it("restarts from accepted state without replaying the POST", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(
        JSON.stringify({
          object_id: "obj-1",
          namespace: item().namespace,
          content: item().content,
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    outbox.markAccepted(row.id, "obj-1");
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    expect((await worker.awaitTerminal(row.id, 1000))?.state).toBe("verified");
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    await worker.stop();
    outbox.close();
  });

  it("turns 401 into durable dead state instead of retrying forever", async () => {
    const fetch: FetchLike = async () => new Response("unauthorized", { status: 401 });
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 1000);
    expect(terminal?.state).toBe("dead");
    expect(outbox.health()).toMatchObject({ dead: 1, degraded: true });
    await worker.stop();
    outbox.close();
  });

  it("turns 403 scope denial into durable dead state", async () => {
    const fetch: FetchLike = async () => new Response("forbidden", { status: 403 });
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    expect((await worker.awaitTerminal(row.id, 1000))?.state).toBe("dead");
    await worker.stop();
    outbox.close();
  });

  it("fails closed when canonical readback identity does not match the accepted write", async () => {
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ object_id: "obj-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          object_id: "wrong",
          namespace: item().namespace,
          content: item().content,
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 1000);
    expect(terminal?.state).toBe("dead");
    expect(terminal?.last_error).toContain("readback identity mismatch");
    await worker.stop();
    outbox.close();
  });

  it("verifies via server dedup-merge when readback content differs but carries the receipt tag", async () => {
    // The episodic plane merges factually-compatible near-duplicates into
    // the EXISTING row (longer-wins content, tag union) and returns that
    // row's object_id. Readback content then legitimately differs from the
    // submission, but the merged row carries our receipt tag — proof the
    // delivery landed. This must verify, not dead-letter.
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ object_id: "obj-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          object_id: "obj-1",
          namespace: item().namespace,
          content: "Durable note, with the longer canonical casing the server kept.",
          tags: ["source:test", "kind:episode", `openclaw:idem-${item().idempotencyKey}`],
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 1000);
    expect(terminal).toMatchObject({ state: "verified", object_id: "obj-1" });
    await worker.stop();
    outbox.close();
  });

  it("still dead-letters a content mismatch whose readback lacks the receipt tag", async () => {
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ object_id: "obj-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          object_id: "obj-1",
          namespace: item().namespace,
          content: "entirely different content",
          tags: ["source:test"],
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 1000);
    expect(terminal?.state).toBe("dead");
    expect(terminal?.last_error).toContain("content_sha256");
    await worker.stop();
    outbox.close();
  });

  it("defers replay when receipt lookup is degraded, preventing a duplicate POST", async () => {
    let posts = 0;
    const fetch: FetchLike = async (_url, init) => {
      posts += init?.method === "POST" ? 1 : 0;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    outbox.markFailed(row.id, "network", true, -1_000_000);
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((outbox.row(row.id)?.attempts ?? 0) >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(posts).toBe(1); // receipt lookup itself is POST /v1/retrieve
    expect(outbox.row(row.id)?.object_id).toBeNull();
    expect(outbox.row(row.id)?.last_error).toContain("receipt lookup");
    await worker.stop();
    outbox.close();
  });

  it("aborts an in-flight request before closing the worker", async () => {
    let aborted = false;
    const fetch: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    const { outbox } = open();
    outbox.enqueue(item());
    const worker = new DeliveryWorker({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      outbox,
      logger,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.stop();
    expect(aborted).toBe(true);
    outbox.close();
  });
});
