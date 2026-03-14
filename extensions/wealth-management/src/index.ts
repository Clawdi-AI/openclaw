import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { WEALTH_MANAGEMENT_WORKFLOWS } from "./lib/catalog.js";
import { createWorkflowTool } from "./lib/workflow-tool.js";

export default function register(api: OpenClawPluginApi) {
  for (const workflow of WEALTH_MANAGEMENT_WORKFLOWS) {
    api.registerTool(createWorkflowTool(workflow));
  }
}
