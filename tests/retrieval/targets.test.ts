import { describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { resolvePresence } from "../../src/presence/resolver.js";
import { buildRetrieveTargets, type RetrieveTarget } from "../../src/retrieval/targets.js";

function presence(
  presence_defaultId: string,
  overrides: Partial<MusubiConfig["presence"]> = {},
): ReturnType<typeof resolvePresence> {
  const config: MusubiConfig = {
    core: { baseUrl: "https://musubi.test", token: "mbi_test" },
    presence: { defaultId: presence_defaultId, ...overrides },
  };
  return resolvePresence(config);
}

describe("buildRetrieveTargets", () => {
  it("returns one target with the caller's owner and the family-discovery namespace", () => {
    const p = presence("eric/openclaw");
    const targets: RetrieveTarget[] = buildRetrieveTargets(p, ["episodic", "curated"]);
    expect(targets).toEqual([
      { namespace: undefined, planes: ["episodic", "curated"], expectedOwner: "eric" },
    ]);
  });

  it("throws on a malformed presence so the failure surfaces at registration, not at retrieval", () => {
    // The split("/", 1)[0] guard in buildRetrieveTargets must catch an
    // empty owner. resolvePresence already rejects the same shape
    // earlier in the pipeline, but buildRetrieveTargets must remain
    // robust to a future caller that bypasses it.
    const p = presence("eric/openclaw");
    // Simulate a downstream code path that built the presence ad-hoc.
    const malformed = { ...p, presence: "" };
    expect(() => buildRetrieveTargets(malformed, ["episodic"])).toThrow(/invalid Musubi presence/u);
  });

  it("documents the multi-target invariant: when this ever returns N targets, all owners must match", () => {
    // This is a structural test that documents the identity-boundary
    // contract search.ts relies on: any future change to return more
    // than one target must keep `expectedOwner` uniform across the list.
    // Today the function always returns exactly one target, so the
    // assertion is trivial; if it ever returns a list, this test still
    // pins the invariant.
    const p = presence("eric/openclaw");
    const targets = buildRetrieveTargets(p, ["episodic"]);
    const owners = new Set(targets.map((t) => t.expectedOwner));
    expect(owners.size).toBe(1);
  });
});
