import { afterAll, afterEach, vi } from "vitest";
import { installProcessWarningFilter } from "../../src/infra/warning-filter.js";
import { withIsolatedTestHome } from "../../test/test-env.js";

process.env.VITEST = "true";
process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS ??= "60000";

const testEnv = withIsolatedTestHome();

installProcessWarningFilter();

afterAll(() => {
  testEnv.cleanup();
});

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
