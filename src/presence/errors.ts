/**
 * Errors raised by the presence resolver.
 *
 * Callers can switch on `code` to handle each failure mode programmatically;
 * the message carries enough context for operators to fix the misconfiguration
 * without code-diving.
 */

export type PresenceResolutionErrorCode =
  | "missing-token"
  | "strict-mode-mismatch"
  | "invalid-presence";

export class PresenceResolutionError extends Error {
  readonly code: PresenceResolutionErrorCode;
  readonly agentId: string | undefined;

  constructor(message: string, code: PresenceResolutionErrorCode, agentId?: string) {
    super(message);
    this.name = "PresenceResolutionError";
    this.code = code;
    this.agentId = agentId;
  }
}
