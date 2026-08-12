import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("publish artifact", () => {
  it("does not retain deleted sidecar modules in dist", () => {
    for (const stalePath of [
      "dist/capture/mirror.js",
      "dist/plugin/lifecycle.js",
      "dist/supplement/corpus.js",
      "dist/supplement/prompt.js",
      "dist/supplement/retrieve-targets.js",
      "dist/thoughts/stream.js",
    ]) {
      expect(existsSync(resolve(root, stalePath)), stalePath).toBe(false);
    }
  });
});
