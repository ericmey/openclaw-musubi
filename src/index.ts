import { definePluginEntry, type OpenClawPluginDefinition } from "./api.js";
import { registerMusubi } from "./plugin/bootstrap.js";

const musubiPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "musubi",
  name: "Musubi Memory",
  description:
    "First-class durable Musubi memory provider for OpenClaw: native recall/store tools, verified episodic capture, and operator-visible delivery health.",
  kind: "memory",
  register(api) {
    registerMusubi({ api, rawConfig: api.pluginConfig });
  },
});

export default musubiPlugin;
