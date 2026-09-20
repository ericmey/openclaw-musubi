import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryController } from "../../src/delivery/controller.js";
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

describe("episodic ceiling at the delivery boundary", () => {
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  it("enqueues a truncated capture whose sha matches the bytes it will send", () => {
    const { outbox } = open();
    const controller = new DeliveryController({
      client: new MusubiClient({
        baseUrl: config.core.baseUrl,
        token: "default",
        fetch: async () => new Response("{}", { status: 200 }),
      }),
      config,
      logger,
      createOutbox: () => outbox,
    });

    return (async () => {
      await controller.start(join(mkdtempSync(join(tmpdir(), "musubi-ceiling-")), "o.sqlite"));
      try {
        const row = controller.enqueueCapture({
          id: "oversize-turn",
          agentId: "aoi",
          content: "あ".repeat(20_000),
        });

        const stored = outbox.row(row.id);
        expect(bytes(stored?.content ?? "")).toBeLessThanOrEqual(32_768);
        // The worker posts `content` and verifies readback against
        // `content_sha256`. If truncation happened anywhere downstream of the
        // hash, every oversized capture would dead-letter as an identity
        // mismatch instead of the 422 it used to dead-letter as.
        expect(stored?.content_sha256).toBe(
          createHash("sha256")
            .update(stored?.content ?? "")
            .digest("hex"),
        );
      } finally {
        await controller.stop();
      }
    })();
  });

  it("refuses an oversized explicit remember instead of queueing a doomed row", async () => {
    const { outbox } = open();
    const controller = new DeliveryController({
      client: new MusubiClient({
        baseUrl: config.core.baseUrl,
        token: "default",
        fetch: async () => new Response("{}", { status: 200 }),
      }),
      config,
      logger,
      createOutbox: () => outbox,
    });
    await controller.start(join(mkdtempSync(join(tmpdir(), "musubi-ceiling-")), "o.sqlite"));

    try {
      // An agent chose these words and can see the tool result, so a refusal
      // it can act on beats silently storing something shorter — and beats a
      // 422 dead-letter it would never be told about.
      expect(() =>
        controller.enqueueExplicit({
          toolCallId: "call-big",
          content: "a".repeat(40_000),
          importance: 7,
          topics: [],
          idempotencyKey: "idem-big",
        }),
      ).toThrow(/32768.*Split it into/s);
      expect(outbox.rowForIdempotency("idem-big")).toBeUndefined();
      expect(outbox.health().pending).toBe(0);
    } finally {
      await controller.stop();
    }
  });
});

describe("DeliveryOutbox degradation lifecycle", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("stops alarming once a death ages out of the alert window", () => {
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const died = Date.now();
    outbox.markFailed(row.id, "permanent rejection", false, died);

    expect(outbox.health(died)).toMatchObject({ dead: 1, recentDead: 1, degraded: true });
    // A delivery that died last week must not pin /musubi-status to
    // "degraded" forever — an alarm nobody can clear is an alarm nobody reads.
    // The row itself is still there to inspect.
    expect(outbox.health(died + 2 * DAY)).toMatchObject({
      dead: 1,
      recentDead: 0,
      degraded: false,
    });
    outbox.close();
  });

  it("retires dead rows past retention but keeps them for post-mortem first", () => {
    const { outbox } = open();
    const row = outbox.enqueue(item());
    const died = Date.now();
    outbox.markFailed(row.id, "permanent rejection", false, died);

    expect(outbox.prune(died + 29 * DAY)).toBe(0);
    expect(outbox.row(row.id)?.last_error).toContain("permanent rejection");
    expect(outbox.prune(died + 31 * DAY)).toBe(1);
    expect(outbox.row(row.id)).toBeUndefined();
    outbox.close();
  });

  it("backfills a dead row left NULL by an interrupted migration", () => {
    const { path, outbox } = open();
    const row = outbox.enqueue(item());
    outbox.markFailed(row.id, "permanent rejection", false);
    outbox.close();

    // The state a crash between ALTER TABLE and its backfill leaves behind:
    // the column exists, so a branch-guarded backfill would skip it forever.
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE delivery_outbox SET died_at_ms = NULL WHERE state = 'dead'");
    raw.close();

    const reopened = new DeliveryOutbox(path);
    const now = Date.now();

    // Without the backfill this row counts as recentDead forever (health's
    // IS NULL) and is never pruned (prune's IS NOT NULL) — relatching the
    // exact degraded-forever bug this column was added to end.
    expect(reopened.health(now + 2 * DAY)).toMatchObject({ recentDead: 0, degraded: false });
    expect(reopened.prune(now + 31 * DAY)).toBe(1);
    reopened.close();
  });

  it("releases a cancelled lease without charging the row a failure", () => {
    const { outbox } = open();
    const row = outbox.enqueue(item());
    outbox.claimBatch();
    expect(outbox.row(row.id)?.state).toBe("inflight");

    outbox.markDeferred(row.id);

    const after = outbox.row(row.id);
    expect(after?.state).toBe("pending");
    expect(after?.lease_owner).toBeNull();
    // Shutdown is not failure: a few restarts with in-flight rows must not
    // walk a healthy provider toward `degraded`.
    expect(after?.consecutive_failures).toBe(0);
    expect(outbox.health().degraded).toBe(false);
    outbox.close();
  });

  it("reclaims an inflight row whose lease timestamp is NULL", () => {
    const { path, outbox } = open();
    const row = outbox.enqueue(item());
    outbox.claimBatch();
    outbox.close();

    // Force the state a crash between the lease UPDATE and its commit — or an
    // older build — could leave behind. `leased_at_ms < ?` is NULL-false in
    // SQL, so such a row was invisible to claimBatch's stale-lease sweep and
    // could never be retried: a durable capture silently stranded forever.
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE delivery_outbox SET leased_at_ms = NULL WHERE state = 'inflight'");
    raw.close();

    const reopened = new DeliveryOutbox(path);
    const claimed = reopened.claimBatch(20, Date.now() + 10 * 60_000);
    expect(claimed.map((r) => r.id)).toContain(row.id);
    reopened.close();
  });
});

describe("DeliveryWorker failure classification", () => {
  function makeWorker(outbox: DeliveryOutbox, fetch: FetchLike) {
    return new DeliveryWorker({
      client: new MusubiClient({
        baseUrl: config.core.baseUrl,
        token: "default",
        fetch,
        sleep: async () => undefined,
      }),
      config,
      outbox,
      logger,
    });
  }

  it("dead-letters a corrupt ledger row instead of retrying it forever", async () => {
    const { path, outbox } = open();
    const row = outbox.enqueue(item());
    outbox.close();

    const raw = new DatabaseSync(path);
    raw.exec("UPDATE delivery_outbox SET tags_json = '\"not-an-array\"'");
    raw.close();

    const reopened = new DeliveryOutbox(path);
    const worker = makeWorker(reopened, async () => new Response("{}", { status: 200 }));
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);

    // Corruption is permanent. Classifying every non-HTTP error as retryable
    // meant this row span forever: never delivered, never dead-lettered, and
    // dragging the provider into `degraded` via oldestPendingAgeMs.
    expect(terminal?.state).toBe("dead");
    expect(terminal?.last_error).toContain("tags_json");
    await worker.stop();
    reopened.close();
  });

  it("accepts a receipt envelope whose limit echo differs from the request", async () => {
    let posts = 0;
    const fetch: FetchLike = async (url, init) => {
      if (init?.method === "POST" && url.includes("/v1/retrieve")) {
        posts += 1;
        // Server clamped the echo. Not degraded — but demanding `limit === 50`
        // turned every retry of an already-attempted row into a hard stall.
        return new Response(
          JSON.stringify({
            mode: "recent",
            limit: 25,
            warnings: [],
            results: [{ object_id: "obj-existing" }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          object_id: "obj-existing",
          namespace: "aoi/command-chair/episodic",
          content: "durable note",
          tags: [],
        }),
        { status: 200 },
      );
    };
    const { outbox } = open();
    const row = outbox.enqueue(item());
    outbox.markFailed(row.id, "network", true, -1_000_000);

    const worker = makeWorker(outbox, fetch);
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);

    expect(posts).toBe(1);
    expect(terminal?.state).toBe("verified");
    expect(terminal?.object_id).toBe("obj-existing");
    await worker.stop();
    outbox.close();
  });
});
