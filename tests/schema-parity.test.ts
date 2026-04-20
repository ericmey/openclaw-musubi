import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: Array<{ const?: unknown }>;
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
    const pathsOf = (root: JsonSchemaNode): Map<string, string | undefined> => {
      const map = new Map<string, string | undefined>();
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
      expect(tbType, `type mismatch at ${path || "<root>"}`).toEqual(manType);
    }
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
