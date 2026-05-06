/**
 * Translate an OpenClaw capture-eligible event into a Musubi episodic
 * capture payload. Pure function — no I/O. Easy to test in isolation.
 *
 * The `idempotencyKey` is derived from the source event id so a retried
 * mirror call posts to the same logical capture rather than creating
 * duplicates. See ADR-0001 for why dual-write is acceptable.
 */
export const TAG_SOURCE_PREFIX = "src:";
export const TAG_REF_PREFIX = "ref:";
/**
 * Convert the plugin-internal rich capture payload into the narrow
 * body shape the canonical Musubi API accepts. `capture_source` and
 * `source_ref` survive as prefixed tags (`src:openclaw-agent-end`,
 * `ref:<event-id>`) so downstream retrieval can still filter on
 * origin.
 *
 * `timestamp` is dropped: the Musubi server assigns `created_at`
 * at ingest time, and only operator-scoped callers may override it
 * (see Musubi #140). This plugin does not hold operator scope.
 *
 * `metadata` is dropped today because every call site sends `{}`.
 * If a real need emerges the canonical `CaptureRequest` will grow
 * a field upstream and this translator flips.
 */
export function toCanonicalCapture(payload) {
    const tags = [
        ...payload.topics,
        `${TAG_SOURCE_PREFIX}${payload.capture_source}`,
        `${TAG_REF_PREFIX}${payload.source_ref}`,
    ];
    return {
        namespace: payload.namespace,
        content: payload.content,
        importance: payload.importance,
        tags,
    };
}
const CAPTURE_SOURCE = "openclaw-agent-end";
const DEFAULT_IMPORTANCE = 5;
const IDEMPOTENCY_PREFIX = "openclaw-mirror";
export function translateCaptureEvent(event, presence, now = () => new Date()) {
    return {
        namespace: presence.namespaces.episodic,
        content: event.content,
        capture_source: CAPTURE_SOURCE,
        source_ref: event.id,
        timestamp: event.timestamp ?? now().toISOString(),
        importance: clampImportance(event.importance ?? DEFAULT_IMPORTANCE),
        topics: event.topics ?? [],
        metadata: event.metadata ?? {},
    };
}
export function deriveIdempotencyKey(event) {
    return `${IDEMPOTENCY_PREFIX}:${event.id}`;
}
function clampImportance(value) {
    if (!Number.isFinite(value))
        return DEFAULT_IMPORTANCE;
    return Math.max(1, Math.min(10, Math.round(value)));
}
//# sourceMappingURL=translate.js.map