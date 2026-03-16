import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 20_000,
    teardownTimeout: 20_000,
    testTimeout: 10_000,
  },
});
