import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatConnectorsPrompt, loadConnectors } from "./hook.js";

describe("work-connectors hook", () => {
  let tempDir = "";

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-work-connectors-"));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("formatConnectorsPrompt", () => {
    it("formats connectors into prompt block", () => {
      const connectors = {
        "~~crm": { backend: "composio", ref: "clawdi-mcp.HUBSPOT_*" },
        "~~chat": { backend: "skill", ref: "slack" },
        "~~enrichment": { backend: "mcporter", ref: "zoominfo" },
      };

      const result = formatConnectorsPrompt(connectors);

      expect(result).toContain("## Connector Resolution");
      expect(result).toContain("~~crm: use composio (clawdi-mcp.HUBSPOT_*)");
      expect(result).toContain("~~chat: use the slack skill");
      expect(result).toContain("~~enrichment: use mcporter (zoominfo)");
      expect(result).toContain("skill:<name>");
      expect(result).toContain("mcporter call <ref>.<tool_name>");
      expect(result).toContain("composio skill workflow");
      expect(result).toContain("connectors.json");
    });

    it("returns empty string for empty connectors", () => {
      expect(formatConnectorsPrompt({})).toBe("");
    });

    it("returns empty string for null", () => {
      expect(formatConnectorsPrompt(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
      expect(formatConnectorsPrompt(undefined)).toBe("");
    });

    it("includes file path when provided", () => {
      const connectors = {
        "~~crm": { backend: "composio", ref: "clawdi-mcp.HUBSPOT_*" },
      };
      const result = formatConnectorsPrompt(connectors, "/path/to/connectors.json");
      expect(result).toContain("Connector config file: /path/to/connectors.json");
      expect(result).toContain("edit the JSON entry");
    });
  });

  describe("loadConnectors", () => {
    it("reads and parses connectors.json", async () => {
      const filePath = path.join(tempDir, "connectors.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          connectors: {
            "~~crm": { backend: "composio", ref: "clawdi-mcp.HUBSPOT_*" },
            "~~chat": { backend: "skill", ref: "slack" },
          },
        }),
      );

      const result = await loadConnectors(filePath);

      expect(result).toEqual({
        "~~crm": { backend: "composio", ref: "clawdi-mcp.HUBSPOT_*" },
        "~~chat": { backend: "skill", ref: "slack" },
      });
    });

    it("returns empty object for missing file", async () => {
      const result = await loadConnectors(path.join(tempDir, "nonexistent.json"));
      expect(result).toEqual({});
    });
  });
});
