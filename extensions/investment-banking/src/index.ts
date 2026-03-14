import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { INVESTMENT_BANKING_WORKFLOWS } from "./lib/catalog.js";
import { createWorkflowTool } from "./lib/workflow-tool.js";

export default function register(api: OpenClawPluginApi) {
  for (const workflow of INVESTMENT_BANKING_WORKFLOWS) {
    api.registerTool(createWorkflowTool(workflow));
  }
}
