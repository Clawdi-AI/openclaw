import { describe, expect, it } from "vitest";
import { __testing } from "./mcp-transport.js";

describe("mcp transport runtime config", () => {
  it("resolves MCP bearer auth and headers from SecretRefs", async () => {
    const resolved = await __testing.resolveMcpServerRuntimeConfig(
      "clawdi-mcp",
      {
        url: "https://api.example.com/composio/mcp",
        transport: "streamable-http",
        auth: {
          type: "bearer",
          token: {
            source: "env",
            provider: "clawdi",
            id: "CLAWDI_PROXY_TOKEN",
          },
        },
        headers: {
          "X-Clawdi-Trace": {
            source: "env",
            provider: "clawdi",
            id: "CLAWDI_TRACE_TOKEN",
          },
          "X-Retry": 1,
        },
      },
      {
        cfg: {
          secrets: {
            providers: {
              clawdi: {
                source: "env",
                allowlist: ["CLAWDI_PROXY_TOKEN", "CLAWDI_TRACE_TOKEN"],
              },
            },
          },
        },
        env: {
          CLAWDI_PROXY_TOKEN: "proxy-token",
          CLAWDI_TRACE_TOKEN: "trace-token",
        },
      },
    );

    expect(resolved).toMatchObject({
      headers: {
        Authorization: "Bearer proxy-token",
        "X-Clawdi-Trace": "trace-token",
        "X-Retry": "1",
      },
    });
  });
});
