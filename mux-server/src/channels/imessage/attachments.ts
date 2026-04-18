import { asRecord, readNonEmptyString } from "../../domain/values.js";

// Standard base64 alphabet + 0-2 trailing '=' padding. Node's
// Buffer.from(..., "base64") silently drops invalid characters and returns
// partial bytes rather than throwing, so this regex + `length % 4` together
// are the actual guard against malformed input. URL-safe base64 (`-_`) is
// intentionally rejected here: Buffer.from would silently accept it, but the
// contract is "standard base64" so callers that ship URL-safe strings know
// to re-encode. Linear-time, no backreferences, no ReDoS risk.
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type InlineIMessageAttachment = {
  filename: string;
  contentType: string;
  body: Buffer;
};

export type InlineAttachmentParseResult =
  | { ok: true; attachments: InlineIMessageAttachment[] }
  | { ok: false; error: string };

// Returns a tight upper bound on the decoded byte count WITHOUT allocating
// a Buffer. Used to enforce per-attachment and cumulative caps before
// Buffer.from runs, so a runtime-token holder cannot force mux to allocate
// past IMESSAGE_ATTACHMENT_MAX_BYTES via many small or a few huge payloads.
function estimateDecodedBytes(dataBase64: string): number {
  const paddingChars = dataBase64.match(/=+$/)?.[0].length ?? 0;
  return Math.floor((dataBase64.length * 3) / 4) - paddingChars;
}

/**
 * Decode + validate the `raw.imessage.send.attachments[]` envelope field.
 *
 * Rules:
 *   - Each entry must be an object with non-empty `filename`, `contentType`,
 *     and `dataBase64` (standard base64, length divisible by 4).
 *   - No entry's decoded size may exceed `maxBytes`.
 *   - The sum of decoded sizes must not exceed `maxBytes`.
 *
 * All caps are enforced against the pre-decode estimate so nothing is
 * allocated past the limit. The decoded buffer length must match the
 * estimate exactly once the charset guard has passed; the empty-buffer
 * check is defense-in-depth against a future Node behavior change.
 */
export function parseInlineAttachments(
  raw: unknown,
  maxBytes: number,
): InlineAttachmentParseResult {
  if (raw === undefined || raw === null) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "raw.imessage.send.attachments must be an array",
    };
  }

  const attachments: InlineIMessageAttachment[] = [];
  let cumulativeBytes = 0;

  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) {
      return {
        ok: false,
        error: "raw.imessage.send.attachments entries must be objects",
      };
    }
    const filename = readNonEmptyString(entry.filename);
    const contentType = readNonEmptyString(entry.contentType);
    const dataBase64 = readNonEmptyString(entry.dataBase64);
    if (!filename || !contentType || !dataBase64) {
      return {
        ok: false,
        error: "raw.imessage.send.attachments entry missing filename/contentType/dataBase64",
      };
    }
    if (dataBase64.length % 4 !== 0 || !STANDARD_BASE64.test(dataBase64)) {
      return { ok: false, error: `attachment ${filename} is not valid base64` };
    }

    const estimated = estimateDecodedBytes(dataBase64);
    if (estimated <= 0) {
      return { ok: false, error: `attachment ${filename} decoded to zero bytes` };
    }
    if (estimated > maxBytes) {
      return {
        ok: false,
        error: `attachment ${filename} exceeds ${maxBytes} bytes (estimated ${estimated})`,
      };
    }
    if (cumulativeBytes + estimated > maxBytes) {
      return {
        ok: false,
        error: `cumulative attachment size exceeds ${maxBytes} bytes`,
      };
    }

    const body = Buffer.from(dataBase64, "base64");
    if (body.length === 0) {
      return { ok: false, error: `attachment ${filename} decoded to zero bytes` };
    }
    // Accumulate via the pre-decode estimate so the cap accounting stays
    // in a single unit with the per-item check; for valid standard base64
    // `body.length` equals the estimate, but mixing them would drift if a
    // future change relaxed the charset guard.
    cumulativeBytes += estimated;
    attachments.push({ filename, contentType, body });
  }

  return { ok: true, attachments };
}
