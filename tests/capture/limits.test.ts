import { describe, expect, it } from "vitest";

import {
  EPISODIC_CONTENT_LIMIT_BYTES,
  sliceToUtf8Bytes,
  truncateForEpisodicCapture,
  utf8ByteLength,
} from "../../src/capture/limits.js";

const bytes = (value: string) => new TextEncoder().encode(value).length;

describe("utf8ByteLength", () => {
  it("agrees with TextEncoder across the encoding widths", () => {
    for (const sample of [
      "",
      "plain ascii",
      "café",
      "日本語のテキスト",
      "👩‍👩‍👧‍👦 family",
      "𝔘𝔫𝔦",
    ]) {
      expect(utf8ByteLength(sample), sample).toBe(bytes(sample));
    }
  });
});

describe("sliceToUtf8Bytes", () => {
  it("measures bytes, not characters", () => {
    // Each of these is 3 UTF-8 bytes, so 10 bytes fits exactly 3 of them.
    const japanese = "あ".repeat(10);
    const sliced = sliceToUtf8Bytes(japanese, 10);
    expect(sliced).toBe("あああ");
    expect(bytes(sliced)).toBeLessThanOrEqual(10);
  });

  it("never splits a multi-byte sequence", () => {
    const value = "aあ"; // 1 + 3 = 4 bytes
    // 2 and 3 bytes cannot hold "a" plus any part of the 3-byte "あ";
    // a byte-blind slice would emit half of it.
    expect(sliceToUtf8Bytes(value, 2)).toBe("a");
    expect(sliceToUtf8Bytes(value, 3)).toBe("a");
    expect(sliceToUtf8Bytes(value, 4)).toBe("aあ");
    expect(sliceToUtf8Bytes(value, 5)).toBe("aあ");
  });

  it("never leaves a lone surrogate behind", () => {
    const value = "😀😀";
    const sliced = sliceToUtf8Bytes(value, 6);
    // A lone surrogate would corrupt the stored memory and change its
    // SHA-256, which the readback check would then call an identity mismatch.
    expect(sliced).toBe("😀");
    expect(sliced).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(bytes(sliced)).toBe(4);
  });

  it("returns empty for a non-positive budget", () => {
    expect(sliceToUtf8Bytes("abc", 0)).toBe("");
    expect(sliceToUtf8Bytes("abc", -1)).toBe("");
  });
});

describe("truncateForEpisodicCapture", () => {
  it("leaves content under the ceiling untouched", () => {
    const content = "a short completed turn";
    const result = truncateForEpisodicCapture(content);
    expect(result).toMatchObject({ content, truncated: false, omittedBytes: 0 });
  });

  it("leaves content exactly at the ceiling untouched", () => {
    const content = "a".repeat(EPISODIC_CONTENT_LIMIT_BYTES);
    const result = truncateForEpisodicCapture(content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("brings oversized ASCII content under the server's ceiling", () => {
    const content = "a".repeat(EPISODIC_CONTENT_LIMIT_BYTES * 2);
    const result = truncateForEpisodicCapture(content);

    expect(result.truncated).toBe(true);
    expect(bytes(result.content)).toBeLessThanOrEqual(EPISODIC_CONTENT_LIMIT_BYTES);
    expect(result.content).toContain("capture truncated by openclaw-musubi");
    expect(result.content).toContain(`of ${EPISODIC_CONTENT_LIMIT_BYTES * 2} UTF-8 bytes omitted`);
  });

  it("brings oversized multi-byte content under the ceiling too", () => {
    // The case a character-based slice gets wrong: 20k characters of
    // Japanese is ~60k bytes, so slicing to 32k CHARACTERS still 422s.
    const content = "あ".repeat(20_000);
    expect(bytes(content)).toBeGreaterThan(EPISODIC_CONTENT_LIMIT_BYTES);

    const result = truncateForEpisodicCapture(content);

    expect(result.truncated).toBe(true);
    expect(bytes(result.content)).toBeLessThanOrEqual(EPISODIC_CONTENT_LIMIT_BYTES);
    expect(result.content.startsWith("あああ")).toBe(true);
  });

  it("reports the omitted byte count honestly", () => {
    const content = "a".repeat(EPISODIC_CONTENT_LIMIT_BYTES + 1_000);
    const result = truncateForEpisodicCapture(content);

    const keptBytes = bytes(result.content.split("\n\n[capture truncated")[0] ?? "");
    expect(result.originalBytes).toBe(EPISODIC_CONTENT_LIMIT_BYTES + 1_000);
    expect(result.omittedBytes).toBe(result.originalBytes - keptBytes);
    // The loss is stated, never silent.
    expect(result.content).toContain(`${result.omittedBytes} of ${result.originalBytes}`);
  });
});
