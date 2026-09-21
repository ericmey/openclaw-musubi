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
const NS_ROOT_DEFAULT = "harness/v2-smoke";
const NS_ROOT_FROM_ENV = process.env.MUSUBI_LIVE_NS_ROOT;
const NS_ROOT = NS_ROOT_FROM_ENV ?? NS_ROOT_DEFAULT;
const describeLive = BASE_URL && TOKEN ? describe : describe.skip;

/**
 * Write straight to stderr rather than through `console` or stdout.
 *
 * Not `console.*`: vitest intercepts it from a test module and swallows what
 * is emitted at import time. Verified, not assumed -- the first version of
 * this announcement used `console.info`, the module demonstrably loaded, and
 * nothing printed.
 *
 * Not stdout either: a machine-readable reporter owns that stream. Writing
 * this line there put it ahead of the document under
 * `vitest --reporter=json` and the output stopped parsing -- measured, after
 * Shiori asked the question. stderr carries diagnostics, stdout carries the
 * artifact, and the announcement is a diagnostic.
 */
function emit(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * The presence this token actually carries, read from its own claims.
 *
 * Printed, never enforced: the server decides, and a token this test cannot
 * parse is still a token the server may accept. Returns null rather than
 * throwing so an opaque credential degrades to "unknown" instead of taking
 * the suite down with it.
 */
function tokenPresence(token: string | undefined): string | null {
  const segments = token?.split(".");
  if (segments?.length !== 3) return null;
  const encoded = segments[1];
  if (encoded === undefined) return null;
  try {
    const body = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      Buffer.from(body + "=".repeat((4 - (body.length % 4)) % 4), "base64").toString("utf8"),
    );
    const presence = (claims as { presence?: unknown })?.presence;
    return typeof presence === "string" ? presence : null;
  } catch {
    return null;
  }
}

/**
 * Why this token cannot write `<ns_root>/episodic`, or null if it plausibly can.
 *
 * Mirrors the server's rule rather than approximating it. `_namespace_matches`
 * in musubi compares segment COUNTS and `*` spans exactly one segment, so a
 * seat scope `<tenant>/<presence>/*:rw` matches a namespace of exactly three
 * segments and nothing else. A prefix test is NOT equivalent and misses the
 * configuration most likely to be tried next: `<presence>/live-smoke` is a
 * prefix match on the presence and still 403s, because the namespace it builds
 * has four segments. (Caught by Shiori on review -- the first version of this
 * check was silent on exactly the trap that motivated the file.)
 *
 * Advisory only, and it can raise a false alarm. It reasons from the PRESENCE
 * claim while the server authorises from SCOPE, and those diverge on at least
 * one real credential: `musubi-operator-aoi` presents `aoi/operator` with
 * scope `aoi/command-chair/*:rw`, so an `aoi/command-chair` run on that token
 * warns about a write it can actually perform. (Shiori, reviewing the fix to
 * her own earlier finding.) The wording hedges accordingly -- a diagnostic
 * that states more than it knows is the failure this file exists to end.
 */
function unwritableReason(nsRoot: string, presence: string | null): string | null {
  if (presence === null) return null;
  const namespace = `${nsRoot}/episodic`;
  if (!namespace.startsWith(`${presence}/`)) {
    return `ns_root ${nsRoot} is outside token presence ${presence}.`;
  }
  const expected = presence.split("/").length + 1;
  const actual = namespace.split("/").length;
  if (actual !== expected) {
    return (
      `namespace ${namespace} has ${actual} segments; a seat scope matches exactly ` +
      `${expected} (presence ${presence} plus one plane), and musubi compares segment counts.`
    );
  }
  return null;
}

/**
 * Say which target this run actually resolved, or why it did not run at all.
 *
 * `NS_ROOT` decides whether the suite can write, and it was taken from a
 * silent default. A green from this suite was therefore unreproducible by
 * construction: the one variable that determines the outcome never appeared
 * in the output anyone pasted. The skip is the same defect in the other
 * direction -- `describe.skip` is the "2 skipped" in every gate run, and a
 * suite that did not run reads identically to one that passed.
 *
 * The namespace is `<tenant>/<presence>/<plane>` and seat scopes are pinned
 * to three segments (`_namespace_matches` in musubi compares segment COUNTS
 * and `*` spans exactly one), so the default tenant `harness` is unwritable
 * by every seat token that exists. That is a decision for the owner, not for
 * this file; this only makes the resolved value visible either way.
 */
function announceLiveTarget(): void {
  if (!BASE_URL || !TOKEN) {
    const missing = [
      BASE_URL ? null : "MUSUBI_LIVE_BASE_URL",
      TOKEN ? null : "MUSUBI_LIVE_TOKEN",
    ].filter((name): name is string => name !== null);
    emit(
      `[live] SKIPPED -- not run, not passed. Missing ${missing.join(" and ")}. ` +
        "These tests are the skipped entries in this suite's summary.",
    );
    return;
  }
  const presence = tokenPresence(TOKEN);
  const source = NS_ROOT_FROM_ENV ? "MUSUBI_LIVE_NS_ROOT" : `default (${NS_ROOT_DEFAULT})`;
  emit(
    `[live] base_url=${BASE_URL} ns_root=${NS_ROOT} (from ${source}) ` +
      `namespace=${NS_ROOT}/episodic token_presence=${presence ?? "unknown"}`,
  );
  const reason = unwritableReason(NS_ROOT, presence);
  if (reason !== null) {
    emit(
      `[live] NOTE: ${reason} Read as: if a write 403s here, suspect the token's ` +
        "reach before the service. Inferred from the presence claim, which is a " +
        "reliable proxy for scope on a seat token and not on every token -- " +
        "musubi-operator-aoi carries presence aoi/operator with scope " +
        "aoi/command-chair/*:rw, and on that credential this note is a false alarm.",
    );
  }
}

announceLiveTarget();

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
      // Assign BEFORE asserting. A write that was accepted but whose readback
      // is still pending yields an object_id with a non-verified state; if the
      // assertion threw first, `finally` would skip cleanup and leave a
      // diagnostic row behind in a real memory store.
      objectId = terminal?.object_id ?? undefined;
      expect(terminal?.state, terminal?.last_error ?? "no error detail").toBe("verified");
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
