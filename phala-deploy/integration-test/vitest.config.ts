import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "openclaw/plugin-sdk/account-id",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "account-id.ts"),
      },
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
    ],
  },
  test: {
    testTimeout: 150_000,
    hookTimeout: 150_000,
    unstubEnvs: true,
    unstubGlobals: true,
    pool: "forks",
    // Each test spawns an isolated OpenClaw+mux subprocess runner, so extra
    // file-level parallelism mostly adds CPU contention and startup flakiness.
    maxWorkers: 1,
    include: ["phala-deploy/integration-test/**/*.e2e.test.ts"],
    setupFiles: ["phala-deploy/integration-test/setup.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
