import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { EQUITY_RESEARCH_WORKFLOWS } from "./lib/catalog.js";
import { createWorkflowTool } from "./lib/workflow-tool.js";

export default function register(api: OpenClawPluginApi) {
  for (const workflow of EQUITY_RESEARCH_WORKFLOWS) {
    api.registerTool(createWorkflowTool(workflow));
  }
}
