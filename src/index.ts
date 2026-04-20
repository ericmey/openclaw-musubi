/**
 * openclaw-musubi plugin entry point.
 *
 * This is the scaffold. Capability registration (memory supplement, capture
 * hook, recall/remember/think tools, SSE thought consumer) lands in
 * subsequent slices. See `docs/decisions/0001-sidecar-with-authority.md` for
 * the plugin's architectural shape.
 */

import { definePluginEntry } from "./api.js";

export default definePluginEntry({
  id: "musubi",
  name: "Musubi Memory",
  description:
    "Connect OpenClaw agents to a Musubi memory core. Episodic capture mirroring, curated + concept recall via memory supplements, and presence-to-presence thought delivery over SSE.",
  register(api) {
    api.logger.info(
      "musubi plugin loaded (scaffold). Capabilities not yet registered — see docs/decisions/ for the roadmap.",
    );
  },
});
