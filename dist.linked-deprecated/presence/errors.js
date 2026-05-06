/**
 * Errors raised by the presence resolver.
 *
 * Callers can switch on `code` to handle each failure mode programmatically;
 * the message carries enough context for operators to fix the misconfiguration
 * without code-diving.
 */
export class PresenceResolutionError extends Error {
    code;
    agentId;
    constructor(message, code, agentId) {
        super(message);
        this.name = "PresenceResolutionError";
        this.code = code;
        this.agentId = agentId;
    }
}
//# sourceMappingURL=errors.js.map