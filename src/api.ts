/**
 * Local public barrel. External callers should import the entry point only —
 * internal modules within this plugin should also import through this file
 * rather than reaching into `openclaw/plugin-sdk/*` directly, so the plugin
 * has a single place to swap SDK subpaths if upstream reorganizes.
 */

export { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
