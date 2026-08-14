import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MusubiConfigSchema } from "../src/config.js";

/**
 * Schema parity: src/config.ts (TypeBox) must agree with
 * openclaw.plugin.json (JSON Schema) on every load-bearing invariant.
 *
 * The manifest is authoritative for install-time validation; the TypeBox
 * schema gives us typed runtime access. Drift between them is a latent
 * bug that bites at plugin install or first config load.
 *
 * We don't deep-equal the two: TypeBox and JSON Schema legitimately
 * differ on some representation choices (Union-of-literals → anyOf vs
 * enum; Record → patternProperties vs additionalProperties). Instead we
 * assert the invariants that matter per the slice contract.
 */

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  patternProperties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: Array<JsonSchemaNode & { const?: unknown }>;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

const manifestPath = resolve(import.meta.dirname, "..", "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  configSchema: JsonSchemaNode;
};
const manifestSchema: JsonSchemaNode = manifest.configSchema;

// TypeBox schemas carry symbol-keyed metadata that doesn't survive JSON.
// JSON.stringify → JSON.parse strips the symbols and leaves a plain
// JSON-Schema-shaped object.
const typeboxSchema: JsonSchemaNode = JSON.parse(JSON.stringify(MusubiConfigSchema));

const AUTHORED_SECRET_INPUT_PATHS = new Set(["core.token"]);

function propertiesOf(node: JsonSchemaNode): Record<string, JsonSchemaNode> {
  return node.properties ?? {};
}

function walkPropertyPaths(
  node: JsonSchemaNode,
  path: string[],
  visit: (child: JsonSchemaNode, childPath: string[]) => void,
): void {
  visit(node, path);
  for (const [key, child] of Object.entries(propertiesOf(node))) {
    walkPropertyPaths(child, [...path, key], visit);
  }
}

function get(root: JsonSchemaNode, path: string[]): JsonSchemaNode {
  let cur: JsonSchemaNode = root;
  for (const segment of path) {
    const next = propertiesOf(cur)[segment];
    if (!next) {
      throw new Error(`missing path ${path.join(".")} at segment ${segment}`);
    }
    cur = next;
  }
  return cur;
}

describe("schema parity: src/config.ts ↔ openclaw.plugin.json", () => {
  it("test_manifest_and_typebox_top_level_keys_match", () => {
    expect(new Set(Object.keys(propertiesOf(typeboxSchema)))).toEqual(
      new Set(Object.keys(propertiesOf(manifestSchema))),
    );
    expect(new Set(typeboxSchema.required ?? [])).toEqual(new Set(manifestSchema.required ?? []));
  });

  it("test_manifest_and_typebox_leaf_types_match", () => {
    const pathsOf = (root: JsonSchemaNode): Map<string, string | string[] | undefined> => {
      const map = new Map<string, string | string[] | undefined>();
      walkPropertyPaths(root, [], (child, path) => {
        map.set(path.join("."), child.type);
      });
      return map;
    };
    const tbPaths = pathsOf(typeboxSchema);
    const manPaths = pathsOf(manifestSchema);

    expect(new Set(tbPaths.keys())).toEqual(new Set(manPaths.keys()));

    for (const [path, manType] of manPaths) {
      const tbType = tbPaths.get(path);
      if (AUTHORED_SECRET_INPUT_PATHS.has(path)) {
        expect(manType, `manifest SecretInput type at ${path}`).toEqual(["string", "object"]);
        // Contract change (2026-08-14): the runtime schema now ALSO admits the
        // authored SecretRef object at secret-input paths. CLI preview
        // contexts (doctor / plugins inspect) skip exec resolution and hand
        // the plugin unresolved refs; rejecting them printed nine bogus
        // "Expected string" register errors per doctor run. Bootstrap's
        // secretsMaterialized guard keeps the RUNTIME consumers string-only.
        const tbNode = get(typeboxSchema, path.split("."));
        const unionMembers = new Set((tbNode.anyOf ?? []).map((m) => m.type));
        expect(unionMembers, `runtime union members at ${path}`).toEqual(
          new Set(["string", "object"]),
        );
        continue;
      }
      expect(tbType, `type mismatch at ${path || "<root>"}`).toEqual(manType);
    }
  });

  it("test_manifest_declares_all_musubi_token_paths_as_secret_inputs", () => {
    const manifestWithContracts = manifest as typeof manifest & {
      configContracts?: {
        secretInputs?: { paths?: Array<{ path?: string; expected?: string }> };
      };
    };
    expect(manifestWithContracts.configContracts?.secretInputs?.paths).toEqual([
      { path: "core.token", expected: "string" },
      { path: "core.perAgentTokens.*", expected: "string" },
    ]);

    const manifestPerAgentTokens = get(manifestSchema, ["core", "perAgentTokens"]);
    const typeboxPerAgentTokens = get(typeboxSchema, ["core", "perAgentTokens"]);
    expect(
      (manifestPerAgentTokens.additionalProperties as JsonSchemaNode | undefined)?.type,
    ).toEqual(["string", "object"]);
    const perAgentValue = typeboxPerAgentTokens.patternProperties?.["^(.*)$"];
    const perAgentUnion = new Set((perAgentValue?.anyOf ?? []).map((m) => m.type));
    expect(perAgentUnion).toEqual(new Set(["string", "object"]));
  });

  it("test_manifest_and_typebox_enum_members_match", () => {
    const manifestPlanes = get(manifestSchema, ["supplement", "planes"]);
    const typeboxPlanes = get(typeboxSchema, ["supplement", "planes"]);

    const manifestValues = new Set<unknown>(manifestPlanes.items?.enum ?? []);

    const typeboxItems = typeboxPlanes.items;
    const typeboxValues = new Set<unknown>(
      typeboxItems?.enum ?? (typeboxItems?.anyOf ?? []).map((branch) => branch.const),
    );

    expect(manifestValues.size, "manifest enum non-empty").toBeGreaterThan(0);
    expect(typeboxValues.size, "typebox enum non-empty").toBeGreaterThan(0);
    expect(typeboxValues).toEqual(manifestValues);
  });

  it("test_manifest_and_typebox_numeric_bounds_match", () => {
    const bounds: Array<[string[], { minimum: number; maximum: number }]> = [
      [["core", "requestTimeoutMs"], { minimum: 1000, maximum: 120_000 }],
      [["supplement", "maxResults"], { minimum: 1, maximum: 50 }],
      [["thoughts", "reconnect", "maxBackoffMs"], { minimum: 1000, maximum: 600_000 }],
    ];

    for (const [path, expected] of bounds) {
      const label = path.join(".");
      const tb = get(typeboxSchema, path);
      const man = get(manifestSchema, path);

      expect(tb.minimum, `${label}: typebox minimum`).toEqual(expected.minimum);
      expect(tb.maximum, `${label}: typebox maximum`).toEqual(expected.maximum);
      expect(man.minimum, `${label}: manifest minimum`).toEqual(expected.minimum);
      expect(man.maximum, `${label}: manifest maximum`).toEqual(expected.maximum);
    }
  });
});
