import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PRIVATE_EQUITY_WORKFLOWS } from "./lib/catalog.js";
import { createWorkflowTool } from "./lib/workflow-tool.js";

export default function register(api: OpenClawPluginApi) {
  for (const workflow of PRIVATE_EQUITY_WORKFLOWS) {
    api.registerTool(createWorkflowTool(workflow));
  }
}
