import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtureCache = new Map<string, unknown>();

export function loadJsonFixture<T>(relativePath: string): T {
  const cached = fixtureCache.get(relativePath);
  if (cached !== undefined) {
    return structuredClone(cached) as T;
  }
  const raw = fs.readFileSync(path.join(fixturesDir, relativePath), "utf8");
  const parsed = JSON.parse(raw) as T;
  fixtureCache.set(relativePath, parsed);
  return structuredClone(parsed);
}
