const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "18790", 10);
const PUBLIC_BASE =
  process.env.PUBLIC_BASE ||
  (process.env.DSTACK_APP_ID && process.env.DSTACK_GATEWAY_DOMAIN
    ? `https://${process.env.DSTACK_APP_ID}-${PORT}.${process.env.DSTACK_GATEWAY_DOMAIN}`
    : `http://localhost:${PORT}`);
const VAULT_PATH =
  process.env.VAULT_PATH ||
  (fs.existsSync("/data")
    ? "/data/.mcporter/credentials.json"
    : path.join(require("os").homedir(), ".mcporter", "credentials.json"));
const MCPORTER_CONFIG_PATH =
  process.env.MCPORTER_CONFIG_PATH ||
  (fs.existsSync("/data")
    ? "/data/.mcporter/mcporter.json"
    : path.join(require("os").homedir(), ".mcporter", "mcporter.json"));

// ---------------------------------------------------------------------------
// MCP servers config — read from MCP_SERVERS_JSON env var
// Format: { "name": { "url": "https://...", "auth": "oauth", "scope": "...", "token_endpoint_auth_method": "..." }, ... }
// Servers without "auth": "oauth" (e.g. exa with API key in URL) are skipped by the dashboard.
// ---------------------------------------------------------------------------
function loadServers() {
  const raw = process.env.MCP_SERVERS_JSON;
  if (!raw) {
    console.error("MCP_SERVERS_JSON env var not set — no servers to configure");
    return { oauthServers: {}, overrides: {}, noAuthServers: {} };
  }
  const parsed = JSON.parse(raw);
  const oauthServers = {};
  const overrides = {};
  const noAuthServers = {};
  for (const [name, cfg] of Object.entries(parsed)) {
    if (cfg.auth === "oauth") {
      oauthServers[name] = cfg.url;
      const ov = {};
      if (cfg.token_endpoint_auth_method) {
        ov.token_endpoint_auth_method = cfg.token_endpoint_auth_method;
      }
      if (cfg.scope) {
        ov.scope = cfg.scope;
      }
      if (Object.keys(ov).length > 0) {
        overrides[name] = ov;
      }
    } else {
      // Non-OAuth servers (e.g. exa with API key in URL) — add to mcporter config immediately
      noAuthServers[name] = cfg.url;
    }
  }
  return { oauthServers, overrides, noAuthServers };
}

const {
  oauthServers: SERVERS,
  overrides: SERVER_OVERRIDES,
  noAuthServers: NO_AUTH_SERVERS,
} = loadServers();

// mcporter vault helpers
function vaultKey(name, url) {
  const descriptor = { name, url, command: null };
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex")
    .slice(0, 16);
  return `${name}|${hash}`;
}

function readVault() {
  try {
    const data = JSON.parse(fs.readFileSync(VAULT_PATH, "utf8"));
    if (data.version === 1 && data.entries) {
      return data;
    }
  } catch {}
  return { version: 1, entries: {} };
}

function writeVault(vault) {
  fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
  fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2));
}

function saveToMcporterVault(name, serverUrl, clientInfo, tokens) {
  const vault = readVault();
  const key = vaultKey(name, serverUrl);
  vault.entries[key] = {
    serverName: name,
    serverUrl: serverUrl,
    clientInfo: clientInfo,
    tokens: tokens,
    updatedAt: new Date().toISOString(),
  };
  writeVault(vault);
  console.log(`[vault] Saved ${name} to mcporter vault (key: ${key})`);

  // Also register in mcporter config so mcporter knows about this server
  addToMcporterConfig(name, serverUrl);
}

// Add a server to mcporter.json (read-modify-write to preserve other entries)
function addToMcporterConfig(name, serverUrl, oauth = true) {
  let cfg = { mcpServers: {}, imports: [] };
  try {
    cfg = JSON.parse(fs.readFileSync(MCPORTER_CONFIG_PATH, "utf8"));
  } catch {}
  if (!cfg.mcpServers) {
    cfg.mcpServers = {};
  }
  const entry = { baseUrl: serverUrl };
  if (oauth) {
    entry.auth = "oauth";
  }
  cfg.mcpServers[name] = entry;
  fs.mkdirSync(path.dirname(MCPORTER_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(MCPORTER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`[config] Added ${name} to mcporter config`);
}

// State
const state = {};
for (const name of Object.keys(SERVERS)) {
  state[name] = {
    status: "pending",
    authUrl: null,
    tools: [],
    error: null,
    authProvider: null,
    transport: null,
    client: null,
  };
}

function createAuthProvider(name) {
  let _clientInfo = null;
  let _codeVerifier = null;
  let _tokens = null;
  const overrides = SERVER_OVERRIDES[name] || {};
  return {
    get redirectUrl() {
      return `${PUBLIC_BASE}/callback/${name}`;
    },
    get clientMetadata() {
      const meta = {
        client_name: `openclaw-${name}`,
        redirect_uris: [`${PUBLIC_BASE}/callback/${name}`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: overrides.token_endpoint_auth_method || "client_secret_post",
      };
      if (overrides.scope) {
        meta.scope = overrides.scope;
      }
      return meta;
    },
    clientInformation() {
      return _clientInfo;
    },
    saveClientInformation(info) {
      _clientInfo = info;
      console.log(`[${name}] Client registered: ${info.client_id}`);
    },
    tokens() {
      return _tokens;
    },
    saveTokens(t) {
      _tokens = t;
      // Save to mcporter vault immediately
      if (_clientInfo) {
        saveToMcporterVault(name, SERVERS[name], _clientInfo, t);
      }
    },
    async saveCodeVerifier(v) {
      _codeVerifier = v;
    },
    codeVerifier() {
      return _codeVerifier;
    },
    async redirectToAuthorization(authUrl) {
      state[name].authUrl = authUrl.toString();
      state[name].status = "awaiting_auth";
      console.log(`[${name}] Auth URL ready`);
    },
    getClientInfo() {
      return _clientInfo;
    },
    getTokens() {
      return _tokens;
    },
    _setTokens(t) {
      _tokens = t;
    },
  };
}

async function initAll() {
  // Check vault for already-authenticated servers (survives restarts)
  const vault = readVault();

  const promises = Object.entries(SERVERS).map(async ([name, serverUrl]) => {
    const url = new URL(serverUrl);
    const key = vaultKey(name, serverUrl);
    const cached = vault.entries[key];

    const authProvider = createAuthProvider(name);
    state[name].authProvider = authProvider;

    // Pre-seed auth provider with cached credentials from vault
    if (cached?.clientInfo && cached?.tokens) {
      authProvider.saveClientInformation(cached.clientInfo);
      // Directly set tokens without re-saving to vault
      authProvider._setTokens(cached.tokens);
      console.log(`[${name}] Restored credentials from vault`);
    }

    const transport = new StreamableHTTPClientTransport(url, { authProvider });
    state[name].transport = transport;
    const client = new Client({ name: "openclaw", version: "1.0" });

    try {
      await client.connect(transport);
      state[name].status = "connected";
      state[name].client = client;

      // List tools for connected servers
      const { tools } = await client.listTools();
      state[name].tools = tools.map((t) => ({
        name: t.name,
        description: (t.description || "").substring(0, 100),
      }));
      console.log(`[${name}] Connected with ${tools.length} tools`);
    } catch (err) {
      if (err.message.includes("nauthorized")) {
        console.log(`[${name}] Needs auth`);
      } else {
        state[name].status = "error";
        state[name].error = err.message;
      }
    }
  });
  await Promise.all(promises);
}

async function handleCallback(name, code) {
  try {
    state[name].status = "exchanging";
    console.log(`[${name}] Got code, exchanging...`);
    await state[name].transport.finishAuth(code);

    state[name].status = "connecting";
    const url = new URL(SERVERS[name]);
    const transport2 = new StreamableHTTPClientTransport(url, {
      authProvider: state[name].authProvider,
    });
    const client = new Client({ name: "openclaw", version: "1.0" });
    await client.connect(transport2);

    state[name].status = "connected";
    state[name].client = client;
    console.log(`[${name}] CONNECTED!`);

    const { tools } = await client.listTools();
    state[name].tools = tools.map((t) => ({
      name: t.name,
      description: (t.description || "").substring(0, 100),
    }));
    console.log(`[${name}] ${tools.length} tools`);
  } catch (err) {
    state[name].status = "error";
    state[name].error = err.message;
    console.log(`[${name}] Error: ${err.message}`);
  }
}

function renderDashboard() {
  const serverCards = Object.entries(state)
    .map(([name, s]) => {
      const statusEmoji =
        {
          pending: "⏳",
          awaiting_auth: "🔑",
          exchanging: "🔄",
          connecting: "🔄",
          connected: "✅",
          error: "❌",
        }[s.status] || "❓";
      const statusText = {
        pending: "Initializing...",
        awaiting_auth: "Click to authorize",
        exchanging: "Exchanging token...",
        connecting: "Connecting...",
        connected: `Connected — ${s.tools.length} tools`,
        error: `Error: ${s.error}`,
      }[s.status];
      let toolsList = "";
      if (s.tools.length > 0) {
        toolsList =
          '<div class="tools">' +
          s.tools
            .map((t) => `<div class="tool"><b>${t.name}</b><span>${t.description}</span></div>`)
            .join("") +
          "</div>";
      }
      let button = "";
      if (s.status === "awaiting_auth" && s.authUrl) {
        button = `<a href="${s.authUrl}" class="btn" target="_blank">Authorize ${name}</a>`;
      }
      return `<div class="card ${s.status}"><div class="card-header"><span class="emoji">${statusEmoji}</span><span class="name">${name}</span><span class="status-badge ${s.status}">${statusText}</span></div>${button}${toolsList}</div>`;
    })
    .join("");
  const connectedCount = Object.values(state).filter((s) => s.status === "connected").length;
  const total = Object.keys(state).length;
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw MCP Onboarding</title><meta http-equiv="refresh" content="3">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:16px;max-width:600px;margin:0 auto}h1{font-size:22px;margin-bottom:4px}.subtitle{color:#888;margin-bottom:20px;font-size:14px}.progress{background:#1a1a1a;border-radius:8px;height:8px;margin-bottom:20px;overflow:hidden}.progress-bar{background:linear-gradient(90deg,#3b82f6,#22c55e);height:100%;transition:width .5s;border-radius:8px}.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:14px;margin-bottom:10px}.card.connected{border-color:#22c55e40}.card.error{border-color:#ef444440}.card.awaiting_auth{border-color:#3b82f640}.card-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}.emoji{font-size:20px}.name{font-weight:600;font-size:16px}.status-badge{font-size:12px;color:#888;margin-left:auto}.status-badge.connected{color:#22c55e}.status-badge.error{color:#ef4444}.status-badge.awaiting_auth{color:#3b82f6}.btn{display:block;background:#3b82f6;color:white;text-decoration:none;padding:10px;border-radius:8px;font-weight:500;text-align:center;margin-top:4px;font-size:15px}.tools{margin-top:8px;max-height:200px;overflow-y:auto}.tool{padding:4px 0;border-top:1px solid #222;font-size:12px}.tool b{color:#93c5fd;margin-right:6px}.tool span{color:#666}.footer{text-align:center;color:#444;font-size:11px;margin-top:16px}</style></head><body>
<h1>OpenClaw MCP Onboarding</h1>
<p class="subtitle">${connectedCount}/${total} connected. Credentials auto-saved to mcporter.</p>
<div class="progress"><div class="progress-bar" style="width:${(connectedCount / total) * 100}%"></div></div>
${serverCards}
<p class="footer">Auto-refreshes every 3s</p></body></html>`;
}

function renderEmpty() {
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw MCP Onboarding</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:40px;text-align:center}h1{font-size:22px;margin-bottom:8px}p{color:#888}</style></head><body>
<h1>OpenClaw MCP Onboarding</h1>
<p>No MCP servers configured. Set MCP_SERVERS_JSON to enable OAuth onboarding.</p></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const cbMatch = url.pathname.match(/^\/callback\/(.+)$/);
  if (cbMatch) {
    const name = cbMatch[1];
    const code = url.searchParams.get("code");
    if (state[name] && code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0a0a;color:#fff"><h1>✅ ${name} authorized!</h1><p style="color:#888">You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`,
      );
      void handleCallback(name, code);
    } else {
      res.writeHead(400);
      res.end("Unknown server or missing code");
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(Object.keys(SERVERS).length > 0 ? renderDashboard() : renderEmpty());
    return;
  }

  // API: call a tool
  if (url.pathname === "/api/call" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { server: serverName, tool, arguments: args } = JSON.parse(body);
        const s = state[serverName];
        if (!s?.client) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Server ${serverName} not connected` }));
          return;
        }
        const result = await s.client.callTool({ name: tool, arguments: args || {} });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const summary = {};
    for (const [name, s] of Object.entries(state)) {
      summary[name] = { status: s.status, tools: s.tools.length, error: s.error };
    }
    res.end(JSON.stringify(summary, null, 2));
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

async function main() {
  fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });

  // Register non-OAuth servers (e.g. exa) in mcporter config immediately
  for (const [name, url] of Object.entries(NO_AUTH_SERVERS)) {
    addToMcporterConfig(name, url, false);
  }

  await new Promise((r) => server.listen(PORT, "0.0.0.0", r));
  console.log(`Dashboard: ${PUBLIC_BASE}/dashboard`);
  if (Object.keys(SERVERS).length > 0) {
    await initAll();
    console.log(`\nReady. Open ${PUBLIC_BASE}/dashboard to authorize all servers.`);
    console.log("Credentials will be saved to mcporter vault automatically.");
  } else {
    console.log("No MCP servers configured. Set MCP_SERVERS_JSON to configure servers.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
