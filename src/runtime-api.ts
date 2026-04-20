/**
 * Internal runtime barrel. Do not import from outside this plugin.
 *
 * Exports the narrow set of SDK runtime helpers used by internal modules
 * (config read, logger, scoped fetch, etc.). Keeping these routed through a
 * single file means a single find/replace updates every consumer when the
 * upstream SDK reorganizes a subpath.
 */

// Intentionally empty until the first slice wires a concrete runtime need.
// See docs/decisions/0001-sidecar-with-authority.md for the plugin's overall
// capability shape.

export {};
