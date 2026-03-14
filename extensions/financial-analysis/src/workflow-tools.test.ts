import { describe, expect, it, vi } from "vitest";
import { createConnectorCatalogTool, resolveConnectorCatalog } from "./lib/connectors.js";
import { createWorkflowTool, type WorkflowSpec } from "./lib/workflow-tool.js";

const compsWorkflow: WorkflowSpec = {
  toolName: "financial_analysis_comps",
  label: "Comparable Company Analysis",
  commandName: "/comps",
  description: "Build a comparable company analysis with trading multiples.",
  argHint: "[company name or ticker]",
  primarySkill: "comps-analysis",
  skillNames: ["comps-analysis"],
  requiredInputs: ["company name or ticker"],
  deliverables: ["Comparable company analysis workbook", "Median / quartile valuation summary"],
  notes: ["Prefer configured institutional data connectors over open web search."],
};

describe("financial analysis workflow tools", () => {
  it("asks for target input when a workflow needs a subject", async () => {
    const tool = createWorkflowTool(compsWorkflow);

    const result = await tool.execute("call-1", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(tool.name).toBe("financial_analysis_comps");
    expect(text).toContain("Missing required input: company name or ticker");
    expect(text).toContain("Mapped from source command /comps");
    expect(result.details).toMatchObject({
      status: "needs_input",
      commandName: "/comps",
      primarySkill: "comps-analysis",
      skillNames: ["comps-analysis"],
    });
  });

  it("returns structured workflow guidance once a target is present", async () => {
    const tool = createWorkflowTool(compsWorkflow);

    const result = await tool.execute("call-2", {
      target: "MSFT",
      context: "Board prep for valuation benchmarking",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("Target: MSFT");
    expect(text).toContain("Primary skill: comps-analysis");
    expect(text).toContain("Comparable company analysis workbook");
    expect(result.details).toMatchObject({
      status: "ready",
      target: "MSFT",
      context: "Board prep for valuation benchmarking",
    });
  });

  it("preserves connector defaults and resolves mcporter-backed connector metadata", async () => {
    const connectors = resolveConnectorCatalog({
      connectors: {
        daloopa: {
          enabled: false,
          apiKeyHeader: "Authorization",
          apiKeyPrefix: "Bearer ",
        },
        factset: {
          apiKey: "test-key",
        },
      },
    });

    expect(connectors.daloopa.enabled).toBe(false);
    expect(connectors.daloopa.baseUrl).toBe("https://mcp.daloopa.com/server/mcp");
    expect(connectors.factset.hasApiKey).toBe(true);
    expect(connectors.factset.transport).toBe("mcp-http");
    expect(connectors.factset.supportLevel).toBe("mcporter");
    expect(connectors.daloopa.authConfigured).toBe(false);
  });

  it("marks connectors with configured mcporter refs as runnable without inline auth", async () => {
    const connectors = resolveConnectorCatalog({
      connectors: {
        factset: {
          mcporterRef: "factset-prod",
        },
      },
    });

    expect(connectors.factset.authConfigured).toBe(true);
    expect(connectors.factset.notes.join("\n")).toContain("mcporter");
  });

  it("lists remote tools through the connector catalog tool", async () => {
    const tool = createConnectorCatalogTool(
      {
        connectors: {
          pitchbook: {
            apiKey: "pb-key",
          },
        },
      },
      {
        listTools: async () => ({
          tools: [{ name: "search_company", description: "Search companies" }],
        }),
        callTool: async () => ({ ok: true }),
      },
    );

    const result = await tool.execute("call-3", {
      action: "list_tools",
      connector: "pitchbook",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("pitchbook");
    expect(text).toContain("search_company");
    expect(result.details).toMatchObject({
      action: "list_tools",
      connector: "pitchbook",
      result: {
        tools: [{ name: "search_company" }],
      },
    });
  });

  it("calls a remote tool through the connector catalog tool", async () => {
    const tool = createConnectorCatalogTool(
      {
        connectors: {
          daloopa: {
            apiKey: "dl-key",
            apiKeyHeader: "Authorization",
            apiKeyPrefix: "Bearer ",
          },
        },
      },
      {
        listTools: async () => ({ tools: [] }),
        callTool: async ({ toolName, args }) => ({
          toolName,
          received: args,
        }),
      },
    );

    const result = await tool.execute("call-4", {
      action: "call_tool",
      connector: "daloopa",
      toolName: "search_company",
      argsJson: '{"ticker":"MSFT"}',
    });

    expect(result.details).toMatchObject({
      action: "call_tool",
      connector: "daloopa",
      toolName: "search_company",
      result: {
        toolName: "search_company",
        received: { ticker: "MSFT" },
      },
    });
  });

  it("rejects disabled connectors for remote actions", async () => {
    const tool = createConnectorCatalogTool(
      {
        connectors: {
          daloopa: {
            enabled: false,
          },
        },
      },
      {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ ok: true }),
      },
    );

    const result = await tool.execute("call-5", {
      action: "list_tools",
      connector: "daloopa",
    });

    expect(result.details).toMatchObject({
      action: "list_tools",
      connector: "daloopa",
      found: true,
      runnable: false,
    });
  });

  it("rejects unknown connectors for remote actions", async () => {
    const tool = createConnectorCatalogTool(
      {},
      {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ ok: true }),
      },
    );

    const result = await tool.execute("call-6", {
      action: "list_tools",
      connector: "unknown",
    });

    expect(result.details).toMatchObject({
      action: "list_tools",
      connector: "unknown",
      found: false,
      runnable: false,
    });
  });

  it("rejects connectors with incomplete auth configuration for remote actions", async () => {
    const tool = createConnectorCatalogTool(
      {
        connectors: {
          daloopa: {
            apiKeyHeader: "Authorization",
          },
        },
      },
      {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ ok: true }),
      },
    );

    const result = await tool.execute("call-7", {
      action: "list_tools",
      connector: "daloopa",
    });

    expect(result.details).toMatchObject({
      action: "list_tools",
      connector: "daloopa",
      found: true,
      runnable: false,
      reason: "missing_auth",
    });
  });

  it("uses configured mcporter refs so auth can be handled by mcporter itself", async () => {
    const listTools = vi.fn(async ({ serverName }: { serverName: string }) => ({
      server: serverName,
      tools: [{ name: "screen_equities" }],
    }));
    const tool = createConnectorCatalogTool(
      {
        connectors: {
          factset: {
            mcporterRef: "factset-prod",
          },
        },
      },
      {
        listTools,
        callTool: async () => ({ ok: true }),
      },
    );

    const result = await tool.execute("call-8", {
      action: "list_tools",
      connector: "factset",
    });

    expect(listTools).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "factset-prod",
      }),
    );
    expect(result.details).toMatchObject({
      action: "list_tools",
      connector: "factset",
      runnable: true,
      result: {
        server: "factset-prod",
        tools: [{ name: "screen_equities" }],
      },
    });
  });
});
