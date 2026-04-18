import { describe, expect, test } from "vitest";
import { parseInlineAttachments } from "../src/channels/imessage/attachments.js";

const MAX = 1024; // 1KB for tight cap tests

// "AAAA" = 3 zero bytes; "AAAAAA==" = 4 zero bytes; easy to reason about.
const THREE_BYTES = "AAAA";
const FOUR_BYTES = "AAAAAA==";

describe("parseInlineAttachments", () => {
  test("undefined and null return empty success", () => {
    expect(parseInlineAttachments(undefined, MAX)).toEqual({ ok: true, attachments: [] });
    expect(parseInlineAttachments(null, MAX)).toEqual({ ok: true, attachments: [] });
  });

  test("non-array fails loudly", () => {
    const result = parseInlineAttachments({ not: "an array" }, MAX);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("array") });
  });

  test("empty array is valid (zero attachments)", () => {
    expect(parseInlineAttachments([], MAX)).toEqual({ ok: true, attachments: [] });
  });

  test("valid single attachment decodes to 3 bytes", () => {
    const result = parseInlineAttachments(
      [{ filename: "a.jpg", contentType: "image/jpeg", dataBase64: THREE_BYTES }],
      MAX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error();
    }
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].body.length).toBe(3);
    expect(result.attachments[0].filename).toBe("a.jpg");
  });

  test("non-object entry rejected", () => {
    const result = parseInlineAttachments(["just a string"], MAX);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("objects") });
  });

  test("missing filename/contentType/dataBase64 rejected", () => {
    for (const entry of [
      { filename: "x", contentType: "image/png" }, // no dataBase64
      { filename: "x", dataBase64: THREE_BYTES }, // no contentType
      { contentType: "x", dataBase64: THREE_BYTES }, // no filename
    ]) {
      const result = parseInlineAttachments([entry], MAX);
      expect(result.ok).toBe(false);
    }
  });

  test("URL-safe base64 (-, _) rejected", () => {
    const result = parseInlineAttachments(
      [{ filename: "a", contentType: "x", dataBase64: "AA-_" }],
      MAX,
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not valid base64") });
  });

  test("length-not-mod-4 rejected", () => {
    const result = parseInlineAttachments(
      [{ filename: "a", contentType: "x", dataBase64: "AAA" }],
      MAX,
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("not valid base64") });
  });

  test("over-max single attachment rejected by estimate, before decode", () => {
    // 2000 base64 chars ≈ 1500 bytes > MAX=1024
    const tooBig = "A".repeat(2000);
    const result = parseInlineAttachments(
      [{ filename: "big", contentType: "x", dataBase64: tooBig }],
      MAX,
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("exceeds") });
  });

  test("cumulative cap rejects the Nth attachment even when each fits alone", () => {
    // 3 × 480 base64 chars ≈ 3 × 360 = 1080 bytes > MAX=1024
    const entry = {
      filename: "piece",
      contentType: "x",
      dataBase64: "A".repeat(480),
    };
    const result = parseInlineAttachments([entry, entry, entry], MAX);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("cumulative"),
    });
  });

  test("multiple valid attachments accumulate correctly", () => {
    const result = parseInlineAttachments(
      [
        { filename: "a", contentType: "x", dataBase64: THREE_BYTES },
        { filename: "b", contentType: "x", dataBase64: FOUR_BYTES },
      ],
      MAX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error();
    }
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments.map((a) => a.body.length)).toEqual([3, 4]);
  });

  test("empty dataBase64 rejected at the non-empty-string layer", () => {
    const result = parseInlineAttachments(
      [{ filename: "a", contentType: "x", dataBase64: "" }],
      MAX,
    );
    expect(result.ok).toBe(false);
  });
});
