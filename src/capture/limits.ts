/**
 * The episodic content ceiling, mirrored from the server.
 *
 * Musubi rejects a capture whose content exceeds
 * `EPISODIC_CONTENT_LIMIT_BYTES` UTF-8 bytes with
 * `422 CONTENT_TOO_LARGE` (`writes_episodic.py § _reject_oversize_content`,
 * enforced on the body-auth edge of `POST /v1/episodic` — so every write
 * this plugin makes, passive or explicit, passes through it).
 *
 * A 422 is a terminal client error, so an oversized turn dead-letters: the
 * memory is lost. That is the right outcome for a corrupt row and the wrong
 * one for a long conversation, which is exactly the case this module exists
 * to handle before the payload ever reaches the wire.
 *
 * The limit is measured in BYTES, not characters. A naive `slice()` is a
 * character operation, so content that is mostly non-ASCII would still
 * exceed the ceiling after being "truncated" — a 32k-character slice of
 * Japanese text is ~96k bytes.
 */
export const EPISODIC_CONTENT_LIMIT_BYTES = 32_768;

/**
 * Bytes reserved for the truncation marker. The marker's own length counts
 * against the ceiling, and its text embeds the byte counts it reports, so
 * the budget is reserved up front rather than solved for.
 */
const MARKER_RESERVE_BYTES = 256;

/** UTF-8 byte length, without allocating an encoder per call. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    bytes += utf8CharLength(char.codePointAt(0) ?? 0);
  }
  return bytes;
}

function utf8CharLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Longest prefix of `value` that fits in `maxBytes` UTF-8 bytes.
 *
 * Iterates by CODE POINT, so it can never split a multi-byte sequence or
 * leave a lone surrogate behind — either of which would corrupt the stored
 * memory and change its SHA-256 in ways the readback check would then
 * report as an identity mismatch.
 */
export function sliceToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = utf8CharLength(char.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

export type CaptureTruncation = {
  readonly content: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly omittedBytes: number;
};

/**
 * Fit passive capture content under the episodic ceiling, marking the cut.
 *
 * Truncating is a real loss and is never silent — the marker states how much
 * was dropped — but it is the lesser loss. The alternative for a completed
 * turn is a `422` the agent never sees, a dead row, and the whole memory
 * gone. Nobody is watching a passive capture to notice and retry it.
 *
 * Deliberately NOT applied to `musubi_remember`: there an agent has chosen
 * what to keep and can see the tool result, so a clear refusal it can act on
 * beats silently storing a different, shorter memory than it asked for.
 */
export function truncateForEpisodicCapture(content: string): CaptureTruncation {
  const originalBytes = utf8ByteLength(content);
  if (originalBytes <= EPISODIC_CONTENT_LIMIT_BYTES) {
    return { content, truncated: false, originalBytes, omittedBytes: 0 };
  }
  const kept = sliceToUtf8Bytes(content, EPISODIC_CONTENT_LIMIT_BYTES - MARKER_RESERVE_BYTES);
  const omittedBytes = originalBytes - utf8ByteLength(kept);
  const marker =
    `\n\n[capture truncated by openclaw-musubi: ${omittedBytes} of ${originalBytes} ` +
    `UTF-8 bytes omitted; Musubi's episodic limit is ${EPISODIC_CONTENT_LIMIT_BYTES} bytes]`;
  return { content: `${kept}${marker}`, truncated: true, originalBytes, omittedBytes };
}
