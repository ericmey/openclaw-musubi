import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import plugin from "../../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("current-state documentation and runtime parity", () => {
  it("keeps manifest, exported definition, native tools, and supported host aligned", () => {
    const manifest = JSON.parse(read("openclaw.plugin.json")) as {
      kind?: string;
      contracts?: { tools?: string[] };
    };
    const pkg = JSON.parse(read("package.json")) as {
      peerDependencies?: { openclaw?: string };
      openclaw?: { compat?: { pluginApi?: string }; build?: { openclawVersion?: string } };
    };
    expect(manifest.kind).toBe("memory");
    expect(plugin.kind).toBe("memory");
    expect(manifest.contracts?.tools).toEqual(
      expect.arrayContaining(["memory_search", "memory_get", "memory_store"]),
    );
    expect(pkg.peerDependencies?.openclaw).toBe(">=2026.7.1");
    expect(pkg.openclaw?.compat?.pluginApi).toBe(">=2026.7.1");
    expect(pkg.openclaw?.build?.openclawVersion).toBe("2026.7.1");
  });

  it("marks the former architecture as historical and indexes the replacement", () => {
    const old = read("docs/decisions/0001-sidecar-with-authority.md");
    const index = read("docs/decisions/README.md");
    expect(old.slice(0, 900)).toMatch(/Status:\*\* Superseded/u);
    expect(old.slice(0, 900)).toContain("Historical record only");
    expect(index).toContain("Superseded by 0004");
    expect(index).toContain("Musubi owns the OpenClaw memory slot");
  });

  it("gives every current architecture page a rerunnable verification source", () => {
    for (const path of [
      "README.md",
      "docs/architecture/overview.md",
      "docs/architecture/wiring.md",
      "docs/decisions/0004-first-class-memory-provider.md",
    ]) {
      const body = read(path);
      expect(body, path).toMatch(/npm test|openclaw plugins inspect/u);
      expect(body, path).toContain('plugins.slots.memory = "musubi"');
    }
  });

  it("contains no active additive registration or parallel-primary claim", () => {
    const source = read("src/plugin/bootstrap.ts");
    expect(source).not.toMatch(/registerMemory(?:Prompt|Corpus)Supplement/u);
    for (const path of [
      "README.md",
      "docs/architecture/overview.md",
      "docs/architecture/wiring.md",
      "docs/api-contract.md",
      "docs/architecture/transport.md",
    ]) {
      const body = read(path);
      expect(body, path).not.toMatch(/native memory engine remains primary/u);
      expect(body, path).not.toMatch(/plugins\.slots\.memory\s*=\s*"memory-core"/u);
      expect(body, path).not.toMatch(/plugins\.slots\.memory\s*=\s*"none"/u);
    }
  });

  it("does not advertise inactive thought delivery or invalid token placeholders", () => {
    const source = read("src/plugin/bootstrap.ts");
    expect(source).not.toContain("createThoughtStream");
    for (const path of [
      "README.md",
      "docs/api-contract.md",
      "docs/architecture/presence-model.md",
      "openclaw.plugin.json",
    ]) {
      const body = read(path);
      expect(body, path).not.toMatch(/\$\{MUSUBI_[A-Z0-9_]+\}/u);
    }
    expect(read("openclaw.plugin.json")).toContain("Deprecated and inactive in this release");
  });
});
