import { describe, expect, it } from "vitest";

import type { MusubiConfig } from "../src/config.js";
import type { DeliveryController } from "../src/delivery/controller.js";
import { runDeepDoctor } from "../src/doctor.js";
import { MusubiClient } from "../src/musubi/client.js";
import type { FetchLike } from "../src/musubi/types.js";

const config: MusubiConfig = {
  core: { baseUrl: "https://musubi.test", token: "default", perAgentTokens: { vesper: "tok" } },
  presence: { defaultId: "hana/hw-7ds", perAgent: { vesper: "vesper/hw-7ds" } },
};

function delivery(state: "verified" | "dead" = "verified"): DeliveryController {
  return {
    enqueueExplicit: () => ({ id: 7 }),
    awaitTerminal: async () => ({
      state,
      object_id: state === "verified" ? "obj-doctor" : null,
      last_error: state === "dead" ? "unauthorized" : null,
    }),
  } as unknown as DeliveryController;
}

function acceptedDelivery(): DeliveryController {
  return {
    enqueueExplicit: () => ({ id: 7 }),
    awaitTerminal: async () => ({
      state: "accepted",
      object_id: "obj-doctor",
      last_error: "readback still pending",
    }),
  } as unknown as DeliveryController;
}

describe("runDeepDoctor", () => {
  it("proves durable delivery, semantic retrieval, and cleanup through the real client", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "POST") {
        return new Response(
          JSON.stringify({ results: [{ object_id: "obj-doctor" }], warnings: [] }),
          {
            status: 200,
          },
        );
      }
      return new Response(null, { status: 204 });
    };
    const result = await runDeepDoctor({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      delivery: delivery(),
      agentId: "vesper",
    });

    expect(result).toMatchObject({
      ok: true,
      namespace: "vesper/hw-7ds/episodic",
      objectId: "obj-doctor",
      cleanup: "archived",
    });
    expect(result.stages).toEqual([
      "queued",
      "canonical-readback-verified",
      "semantic-retrieval-verified",
    ]);
    expect(calls).toEqual([
      "POST https://musubi.test/v1/retrieve",
      "DELETE https://musubi.test/v1/episodic/obj-doctor?namespace=vesper%2Fhw-7ds%2Fepisodic",
    ]);
  });

  it("fails before network retrieval when durable delivery does not verify", async () => {
    let networkCalls = 0;
    const fetch: FetchLike = async () => {
      networkCalls += 1;
      return new Response(null, { status: 500 });
    };
    const result = await runDeepDoctor({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      delivery: delivery("dead"),
      agentId: "vesper",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("delivery did not verify");
    expect(result.cleanup).toBe("not-created");
    expect(networkCalls).toBe(0);
  });

  it("reports cleanup failure instead of leaving a green diagnostic behind", async () => {
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === "POST") {
        return new Response(
          JSON.stringify({ results: [{ object_id: "obj-doctor" }], warnings: [] }),
          {
            status: 200,
          },
        );
      }
      return new Response("cleanup denied", { status: 403 });
    };
    const result = await runDeepDoctor({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      delivery: delivery(),
      agentId: "vesper",
    });

    expect(result).toMatchObject({ ok: false, cleanup: "failed" });
    expect(result.error).toContain("cleanup failed");
  });

  it("archives an accepted object even when canonical verification times out", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return new Response(null, { status: 204 });
    };
    const result = await runDeepDoctor({
      client: new MusubiClient({ baseUrl: config.core.baseUrl, token: "default", fetch }),
      config,
      delivery: acceptedDelivery(),
      agentId: "vesper",
    });

    expect(result).toMatchObject({ ok: false, objectId: "obj-doctor", cleanup: "archived" });
    expect(calls).toEqual([
      "DELETE https://musubi.test/v1/episodic/obj-doctor?namespace=vesper%2Fhw-7ds%2Fepisodic",
    ]);
  });
});
