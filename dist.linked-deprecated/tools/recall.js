import { RecallParameters } from "./parameters.js";
import { executeSearch } from "./search.js";
export function createRecallTool(options) {
    const { logger } = options;
    return {
        recommendedOptional: true,
        definition: {
            name: "musubi_recall",
            description: "[DEPRECATED — use musubi_search] Search Musubi across every plane using the full hybrid + rerank pipeline. Removed in the next minor release.",
            parameters: RecallParameters,
            async execute(_toolCallId, params) {
                const warn = logger?.warn ?? ((m) => console.warn(m));
                warn("musubi_recall is deprecated; use musubi_search (canonical name per ADR 0032 / agent-tools spec). The alias drops in the next minor release.");
                return executeSearch(options, params);
            },
        },
    };
}
//# sourceMappingURL=recall.js.map