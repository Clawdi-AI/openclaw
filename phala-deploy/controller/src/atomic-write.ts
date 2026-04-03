import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomically write `data` to `filePath` by writing to a temp file first,
 * then renaming into place. The temp file is cleaned up on failure.
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.clawditmp.${crypto.randomBytes(6).toString("hex")}`);

  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}
