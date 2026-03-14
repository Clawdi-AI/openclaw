import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { formatConnectorsPrompt, loadConnectors } from "./src/hook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function register(api: OpenClawPluginApi) {
  const connectorsPath = path.join(__dirname, "connectors.json");
  const connectors = await loadConnectors(connectorsPath);

  if (!connectors || Object.keys(connectors).length === 0) {
    api.logger.info("work-connectors: no connectors configured, skipping hook registration");
    return;
  }

  const prompt = formatConnectorsPrompt(connectors, connectorsPath);

  if (!prompt) {
    api.logger.info("work-connectors: empty prompt generated, skipping hook registration");
    return;
  }

  api.on("before_prompt_build", () => {
    return { prependContext: prompt };
  });

  api.logger.info(
    `work-connectors: registered before_prompt_build hook with ${Object.keys(connectors).length} connectors`,
  );
}
