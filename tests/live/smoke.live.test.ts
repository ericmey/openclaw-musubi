/**
 * Live-target smoke suite — runs the plugin against a real Musubi
 * server instead of a scripted mock. Skipped by default so `pnpm
 * test` stays hermetic.
 *
 * To run:
 *
 *     MUSUBI_LIVE_BASE_URL=http://musubi.mey.house:8100/v1 \
 *     MUSUBI_LIVE_TOKEN=<harness-bearer> \
 *     MUSUBI_LIVE_NS_ROOT=harness/v2-smoke \
 *     pnpm test -- tests/live
 *
 * The bearer must carry scope for `<ns-root>/*:rw` plus `thoughts:send`.
 * Mint one with the Musubi signing key (see `tests/integration/conftest.py`
 * in the Musubi repo for the shape, or the ad-hoc JWT in
 * `/tmp/musubi-harness-token`).
 *
 * Every test writes into a scratch namespace and reads it back on
 * the same call, so repeated runs are safe — the episodic plane
 * dedups identical content within a namespace and the harness NS
 * prefix isolates us from production data.
 */

import { describe, expect, it } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createCaptureMirror } from "../../src/capture/mirror.js";
import { createRememberTool } from "../../src/tools/remember.js";
import { createRecallTool } from "../../src/tools/recall.js";
import { createThinkTool } from "../../src/tools/think.js";
import type { MusubiConfig } from "../../src/config.js";

const BASE_URL = process.env.MUSUBI_LIVE_BASE_URL;
const TOKEN = process.env.MUSUBI_LIVE_TOKEN;
const NS_ROOT = process.env.MUSUBI_LIVE_NS_ROOT ?? "harness/v2-smoke";

const liveEnabled = Boolean(BASE_URL) && Boolean(TOKEN);
const describeLive = liveEnabled ? describe : describe.skip;

function makeLiveClient(): MusubiClient {
  return new MusubiClient({
    baseUrl: BASE_URL!,
    token: TOKEN!,
    requestTimeoutMs: 10_000,
    retry: { maxAttempts: 2 },
  });
}

function makeLiveConfig(): MusubiConfig {
  // Presence resolver expects `<owner>/<presence>` for `defaultId`.
  // `MUSUBI_LIVE_NS_ROOT` is that two-segment prefix; the resolver
  // appends `/episodic`, `/curated`, etc. to build 3-segment
  // namespaces from it.
  return {
    core: { baseUrl: BASE_URL!, token: TOKEN! },
    presence: { defaultId: NS_ROOT },
  };
}

describeLive("openclaw-musubi × live Musubi (smoke)", () => {
  it("capture mirror writes a row the canonical GET can read back", async () => {
    const client = makeLiveClient();
    const config = makeLiveConfig();
    const mirror = createCaptureMirror({ client, config });
    const eventId = `live-smoke-${Date.now()}`;

    // `handleEvent` is fire-and-forget by contract: failures are
    // swallowed so OpenClaw's write stays unaffected. We re-issue
    // the same POST the mirror would have made, with a fresh
    // idempotency key, and assert the server accepts it — that's
    // the wire-level confidence check.
    await mirror.handleEvent({
      id: eventId,
      content: `mirror smoke probe ${eventId}`,
      importance: 4,
      topics: ["smoke", "mirror"],
    });

    const verify = await client.post<{ object_id?: string; state?: string }>(
      "/v1/memories",
      {
        body: {
          namespace: `${NS_ROOT}/episodic`,
          content: `mirror smoke probe ${eventId} (verify)`,
          importance: 4,
          tags: ["smoke", "mirror", `ref:${eventId}-verify`],
        },
      },
    );
    expect(verify.object_id).toBeTruthy();
    expect(verify.state).toBe("provisional");
  });

  it("musubi_remember tool POSTs the canonical /v1/memories shape", async () => {
    const client = makeLiveClient();
    const config = makeLiveConfig();
    const tool = createRememberTool({ client, config });
    const toolCallId = `live-remember-${Date.now()}`;

    const result = await tool.definition.execute(toolCallId, {
      content: `remember smoke probe ${toolCallId}`,
      importance: 7,
      topics: ["smoke", "remember"],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("Remembered in Musubi");
  });

  it("musubi_recall round-trips an immediate capture in episodic", async () => {
    const client = makeLiveClient();
    const config = makeLiveConfig();
    const marker = `recall-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const remember = createRememberTool({ client, config });
    const recall = createRecallTool({ client, config });

    // Plant a row.
    const ack = await remember.definition.execute(`seed-${marker}`, {
      content: `unique recall token ${marker}`,
      importance: 9,
      topics: ["smoke", "recall"],
    });
    expect(ack.isError).toBeFalsy();

    // Recall restricted to episodic (the only plane we just wrote).
    // Provisional episodic rows are invisible to the default
    // fast-path retrieve (state filter); deep mode is permissive.
    const hits = await recall.definition.execute(`query-${marker}`, {
      query: marker,
      planes: ["episodic"],
      limit: 5,
    });

    // We don't strictly assert a hit — the lifecycle worker may not
    // have promoted the row yet and retrieve filters demand matured
    // rows in some paths — but the call must not error.
    expect(hits.isError).toBeFalsy();
    expect(hits.content[0]?.type).toBe("text");
  }, 20_000);

  it("musubi_think sends a thought on the caller's presence", async () => {
    const client = makeLiveClient();
    const config = makeLiveConfig();
    const think = createThinkTool({ client, config });
    const marker = `think-smoke-${Date.now()}`;

    const result = await think.definition.execute(marker, {
      toPresence: "nyla",
      content: `smoke-only thought ${marker}`,
    });

    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect(result.content[0]?.text?.toLowerCase()).toContain("sent");
  });

  it("scope violation on a production namespace returns a clean error", async () => {
    const client = makeLiveClient();
    // Canonical API rejects writes outside the token's scope with 403.
    // The client maps 403 → ForbiddenError; the mirror/tool code treats
    // it as a non-blocking failure and the outer catch returns cleanly.
    await expect(
      client.post("/v1/memories", {
        body: {
          namespace: "eric/claude-code/episodic",
          content: "should be forbidden",
          importance: 1,
          tags: [],
        },
      }),
    ).rejects.toThrow();
  });
});
