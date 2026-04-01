import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { atomicWrite } from "../atomic-write";
import { extractToken, timingSafeTokenEqual } from "../auth";
import { backupFile } from "../backup-file";
import { resolveSafePath, verifyCanonicalized, SafePathError } from "../safe-path";

function computeEtag(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

function buildTree(dir: string, rootDir: string): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativePath = path.relative(rootDir, path.join(dir, entry.name));

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: "directory",
        children: buildTree(path.join(dir, entry.name), rootDir),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: "file",
      });
    }
  }

  return nodes;
}

type FileValidationError = { error: string; code?: string; status: 400 | 404 };

function resolveAndValidateFile(
  relativePath: string,
  rootDir: string,
): string | FileValidationError {
  let resolved: string;
  try {
    resolved = resolveSafePath(relativePath, rootDir);
  } catch (e) {
    if (e instanceof SafePathError) {
      return { error: e.message, status: 400 };
    }
    throw e;
  }

  if (!fs.existsSync(resolved)) {
    return {
      code: "file_not_found",
      error: "File does not exist",
      status: 404,
    };
  }

  try {
    verifyCanonicalized(fs.realpathSync(resolved), rootDir);
  } catch (e) {
    if (e instanceof SafePathError) {
      return { error: e.message, status: 400 };
    }
    throw e;
  }

  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    return { error: "Symlinks are not allowed", status: 400 };
  }
  if (!stat.isFile()) {
    return { error: "Not a regular file", status: 400 };
  }

  return resolved;
}

export function registerFileRoutes(app: Hono, expectedToken: string, rootDir: string): void {
  // Auth middleware for all file routes
  app.use("/_clawdi/files/*", async (c, next) => {
    const token = extractToken(c.req.header("authorization"), c.req.url);
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/_clawdi/files/tree", (c) => {
    const tree = buildTree(rootDir, rootDir);
    return c.json({ tree });
  });

  app.get("/_clawdi/files/read", (c) => {
    const relativePath = c.req.query("path");
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const result = resolveAndValidateFile(relativePath, rootDir);
    if (typeof result !== "string") {
      return c.json(
        { error: result.error, ...(result.code && { code: result.code }) },
        result.status,
      );
    }

    const content = fs.readFileSync(result, "utf-8");
    return c.json({ content, etag: computeEtag(content) });
  });

  app.post("/_clawdi/files/write", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const body = rawBody as {
      path?: string;
      content?: string;
      etag?: string;
    };
    if (!body.path || typeof body.content !== "string") {
      return c.json({ error: "Missing or invalid path/content" }, 400);
    }

    const result = resolveAndValidateFile(body.path, rootDir);
    if (typeof result !== "string") {
      return c.json(
        { error: result.error, ...(result.code && { code: result.code }) },
        result.status,
      );
    }

    if (body.etag) {
      const currentContent = fs.readFileSync(result, "utf-8");
      const currentEtag = computeEtag(currentContent);
      if (body.etag !== currentEtag) {
        return c.json({ code: "file_etag_conflict", error: "File was modified externally" }, 409);
      }
    }

    try {
      backupFile(result, rootDir);
    } catch (err) {
      console.warn("[files] Failed to create backup:", err);
    }

    try {
      atomicWrite(result, body.content);
    } catch (err) {
      console.error("[files] atomicWrite failed:", err);
      return c.json({ error: "Failed to write file" }, 500);
    }

    const newEtag = computeEtag(body.content);
    return c.json({ etag: newEtag });
  });
}
