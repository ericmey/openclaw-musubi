import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw loader acceptance", () => {
  it("loads Musubi as the selected memory capability through the real 2026.7.1 loader", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-musubi-loader-"));
    roots.push(stateDir);
    const configPath = join(stateDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          allow: ["musubi"],
          load: { paths: [repoRoot] },
          slots: { memory: "musubi" },
          entries: {
            musubi: {
              enabled: true,
              hooks: { allowConversationAccess: true },
              config: {
                core: { baseUrl: "https://musubi.invalid", token: "loader-test-token" },
                presence: { defaultId: "loader/test" },
                thoughts: { enabled: false },
              },
            },
          },
        },
      }),
    );

    const openclawEntry = resolve(repoRoot, "node_modules/.bin/openclaw");
    const result = spawnSync(
      openclawEntry,
      ["plugins", "inspect", "musubi", "--runtime", "--json"],
      {
        cwd: repoRoot,
        env: {
          HOME: stateDir,
          PATH: process.env.PATH ?? "",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          NO_COLOR: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout, `stderr: ${result.stderr}`).not.toBe("");
    const stdout = result.stdout;
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain('"id":"musubi"');
    expect(JSON.stringify(parsed)).toContain('"kind":"memory"');
    expect(JSON.stringify(parsed)).toContain('"agent_end"');
    expect(JSON.stringify(parsed)).not.toMatch(/registration failed|inert|error.*musubi/iu);

    // The loader must not mutate authored config during a read-only inspect.
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      plugins: { slots: { memory: "musubi" } },
    });
  }, 20_000);

  it("materializes declared SecretRefs before plugin bootstrap in the real gateway runtime", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-musubi-secrets-"));
    roots.push(stateDir);
    const configPath = join(stateDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
        plugins: {
          allow: ["musubi"],
          load: { paths: [repoRoot] },
          slots: { memory: "musubi" },
          entries: {
            musubi: {
              enabled: true,
              hooks: { allowConversationAccess: true },
              config: {
                core: {
                  baseUrl: "https://musubi.invalid",
                  token: {
                    source: "env",
                    provider: "default",
                    id: "MUSUBI_LOADER_TOKEN",
                  },
                  perAgentTokens: {
                    loader: {
                      source: "env",
                      provider: "default",
                      id: "MUSUBI_LOADER_AGENT_TOKEN",
                    },
                  },
                },
                presence: {
                  defaultId: "loader/test",
                  perAgent: { loader: "loader/agent" },
                },
              },
            },
          },
        },
      }),
    );

    const port = await reservePort();
    const openclawEntry = resolve(repoRoot, "node_modules/.bin/openclaw");
    const child = spawn(
      openclawEntry,
      ["gateway", "run", "--port", String(port), "--bind", "loopback", "--auth", "none"],
      {
        cwd: repoRoot,
        env: {
          HOME: stateDir,
          PATH: process.env.PATH ?? "",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          MUSUBI_LOADER_TOKEN: "loader-test-token",
          MUSUBI_LOADER_AGENT_TOKEN: "loader-agent-test-token",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    try {
      await new Promise<void>((resolveStarted, rejectStarted) => {
        const timeout = setTimeout(
          () => rejectStarted(new Error(`gateway did not start in time\n${output}`)),
          15_000,
        );
        const onData = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("musubi first-class memory provider started")) {
            clearTimeout(timeout);
            resolveStarted();
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          rejectStarted(
            new Error(`gateway exited before Musubi started (${code ?? signal})\n${output}`),
          );
        });
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }

    expect(output).not.toMatch(/invalid plugin config|unresolved SecretRef|registration failed/iu);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      plugins: {
        entries: {
          musubi: {
            config: {
              core: {
                token: { source: "env", provider: "default", id: "MUSUBI_LOADER_TOKEN" },
              },
            },
          },
        },
      },
    });
  }, 20_000);
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}
