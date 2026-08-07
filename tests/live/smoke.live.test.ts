/**
 * Explicit live-target smoke. Skipped unless MUSUBI_LIVE_BASE_URL and
 * MUSUBI_LIVE_TOKEN are present. The deep doctor soft-archives its own object.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryController } from "../../src/delivery/controller.js";
import { runDeepDoctor } from "../../src/doctor.js";
import { MusubiClient } from "../../src/musubi/client.js";

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
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "musubi-live-"));
    delivery.start(join(root, "outbox.sqlite"));
  });

  afterAll(async () => {
    await delivery.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("proves durable write, canonical readback, semantic retrieval, and cleanup", async () => {
    const result = await runDeepDoctor({ client, config, delivery });
    expect(result, result.error).toMatchObject({ ok: true, cleanup: "archived" });
  }, 20_000);
});
