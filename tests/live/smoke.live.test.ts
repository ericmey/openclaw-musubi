/**
 * Explicit live-target smoke. Skipped unless MUSUBI_LIVE_BASE_URL and
 * MUSUBI_LIVE_TOKEN are present. The deep doctor soft-archives its own object.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryController } from "../../src/delivery/controller.js";
import { runDeepDoctor } from "../../src/doctor.js";
import { MusubiClient } from "../../src/musubi/client.js";
import { createRecentTool } from "../../src/tools/recent.js";

const BASE_URL = process.env.MUSUBI_LIVE_BASE_URL;
const TOKEN = process.env.MUSUBI_LIVE_TOKEN;
const NS_ROOT = process.env.MUSUBI_LIVE_NS_ROOT ?? "harness/v2-smoke";
const describeLive = BASE_URL && TOKEN ? describe : describe.skip;

const config: MusubiConfig = {
  core: { baseUrl: BASE_URL ?? "https://disabled.invalid", token: TOKEN ?? "disabled" },
  presence: { defaultId: NS_ROOT },
};
const client = new MusubiClient({
  baseUrl: config.core.baseUrl,
  token: config.core.token,
  requestTimeoutMs: 10_000,
  retry: { maxAttempts: 2 },
});
const delivery = new DeliveryController({
  client,
  config,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
let root = "";

describeLive("openclaw-musubi × live Musubi", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "musubi-live-"));
    await delivery.start(join(root, "outbox.sqlite"));
  });

  afterAll(async () => {
    await delivery.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("proves durable write, canonical readback, semantic retrieval, and cleanup", async () => {
    const result = await runDeepDoctor({ client, config, delivery });
    expect(result, result.error).toMatchObject({ ok: true, cleanup: "archived" });
  }, 20_000);

  /**
   * `musubi_recent` runs `POST /v1/retrieve` with `mode="recent"`, where
   * `tags` and `since` are SERVER-side filters and `score` carries
   * `created_epoch`. Mocks cannot prove any of that: they assert the request
   * we believe we are sending, not the envelope Musubi actually answers with.
   * This is the one path where a wire mismatch shows up as a memory tool
   * reporting "nothing" for a memory that is demonstrably there.
   */
  it("proves server-side recent filtering against the real retrieve pipeline", async () => {
    const nonce = randomUUID();
    const marker = `openclaw-musubi live recent probe ${nonce}`;
    const tag = `diagnostic:recent-${nonce}`;
    const namespace = `${NS_ROOT}/episodic`;
    const tool = createRecentTool({ client, config });
    let objectId: string | undefined;

    try {
      const row = delivery.enqueueExplicit({
        toolCallId: `live-recent:${nonce}`,
        content: marker,
        importance: 1,
        topics: [tag, "diagnostic"],
        idempotencyKey: `openclaw-musubi-live-recent-${nonce}`,
      });
      const terminal = await delivery.awaitTerminal(row.id, 20_000);
      expect(terminal?.state, terminal?.last_error ?? "no error detail").toBe("verified");
      objectId = terminal?.object_id ?? undefined;
      expect(objectId).toBeTruthy();

      // Server-side tag filter (AND semantics) across the whole namespace.
      const tagged = await tool.definition.execute("live-1", { tags: [tag], limit: 10 });
      expect(tagged.isError, tagged.content[0]?.text).toBeUndefined();
      expect(tagged.content[0]?.text).toContain(marker);

      // `score_kind: "created_epoch"` — the rendered date must be a real
      // timestamp, not the epoch we fall back to when `score` is missing.
      expect(tagged.content[0]?.text).toMatch(/\[\d{4}-\d{2}-\d{2}T/u);
      expect(tagged.content[0]?.text).not.toContain("1970-01-01");

      // `since` goes on the wire as epoch seconds; an ISO string here would
      // be rejected server-side rather than silently ignored.
      const sincePast = await tool.definition.execute("live-2", {
        tags: [tag],
        since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        limit: 10,
      });
      expect(sincePast.isError, sincePast.content[0]?.text).toBeUndefined();
      expect(sincePast.content[0]?.text).toContain(marker);

      const sinceFuture = await tool.definition.execute("live-3", {
        tags: [tag],
        since: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        limit: 10,
      });
      expect(sinceFuture.content[0]?.text).not.toContain(marker);
    } finally {
      if (objectId) {
        await client
          .delete(`/v1/episodic/${encodeURIComponent(objectId)}`, { query: { namespace } })
          .catch(() => undefined);
      }
    }
  }, 45_000);
});
