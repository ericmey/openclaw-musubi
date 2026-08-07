import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryController } from "../../src/delivery/controller.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "mbi_test" },
    presence: { defaultId: "eric/openclaw" },
  };
}

function controller(options?: { createOutbox?: () => never }): DeliveryController {
  const value = config();
  const fetch: FetchLike = vi.fn((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error("synthetic abort"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), {
        once: true,
      });
    });
  });
  return new DeliveryController({
    client: new MusubiClient({
      baseUrl: value.core.baseUrl,
      token: value.core.token,
      fetch,
    }),
    config: value,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    createOutbox: options?.createOutbox,
  });
}

describe("DeliveryController process authority", () => {
  it("keeps the healthy authority when replacement outbox construction fails", async () => {
    const primary = controller();
    const broken = controller({
      createOutbox: () => {
        throw new Error("synthetic disk failure");
      },
    });
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-musubi-authority-failure-"));
    roots.push(stateDir);
    await primary.start(join(stateDir, "outbox.sqlite"));

    try {
      await expect(broken.start(join(stateDir, "outbox.sqlite"))).rejects.toThrow(
        "synthetic disk failure",
      );
      expect(primary.status()).toMatchObject({ running: true });
      expect(
        primary.enqueueCapture({
          id: "capture-after-failed-replacement",
          content: "synthetic content",
        }),
      ).toMatchObject({ source_ref: "capture-after-failed-replacement" });
    } finally {
      await primary.stop();
    }
  });

  it("keeps an in-flight terminal wait on the current authority after replacement", async () => {
    const primary = controller();
    const replacement = controller();
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-musubi-authority-wait-"));
    roots.push(stateDir);
    const path = join(stateDir, "outbox.sqlite");
    await primary.start(path);
    const row = primary.enqueueCapture({
      id: "capture-during-replacement",
      content: "synthetic content",
    });
    const terminal = primary.awaitTerminal(row.id, 250);

    await replacement.start(path);

    try {
      await expect(terminal).resolves.toMatchObject({ id: row.id });
      expect(replacement.status()).toMatchObject({ running: true });
    } finally {
      await replacement.stop();
      await primary.stop();
    }
  });
});
