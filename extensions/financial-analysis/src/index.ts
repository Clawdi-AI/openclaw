import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { FINANCIAL_ANALYSIS_WORKFLOWS } from "./lib/catalog.js";
import { createConnectorCatalogTool } from "./lib/connectors.js";
import { createWorkflowTool } from "./lib/workflow-tool.js";

export default function register(api: OpenClawPluginApi) {
  for (const workflow of FINANCIAL_ANALYSIS_WORKFLOWS) {
    api.registerTool(createWorkflowTool(workflow));
  }

  api.registerTool(createConnectorCatalogTool(api.pluginConfig ?? {}));
}
