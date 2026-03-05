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
  const connectedCount = Object.values(state).filter((s) => s.status === "connected").length;
  const total = Object.keys(state).length;
  const allDone = connectedCount === total;
  const pct = total > 0 ? Math.round((connectedCount / total) * 100) : 0;

  const serverCards = Object.entries(state)
    .map(([name, s], i) => {
      const statusCfg = {
        pending: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="3s" repeatCount="indefinite"/></circle></svg>`,
          label: "Initializing",
          cls: "pending",
        },
        awaiting_auth: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="2" width="8" height="6" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="10.5" r="1" fill="currentColor"/></svg>`,
          label: "Needs authorization",
          cls: "auth",
        },
        exchanging: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v4l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>`,
          label: "Exchanging token",
          cls: "loading",
        },
        connecting: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v4l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>`,
          label: "Connecting",
          cls: "loading",
        },
        connected: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l2 2 3.5-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
          label: `${s.tools.length} tools`,
          cls: "ok",
        },
        error: {
          icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
          label: "Error",
          cls: "err",
        },
      }[s.status] || { icon: "", label: s.status, cls: "" };

      let action = "";
      if (s.status === "awaiting_auth" && s.authUrl) {
        action = `<a href="${s.authUrl}" class="card-action" target="_blank">
          <span>Connect</span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3h7v7M13 3L6 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>`;
      }

      let toolsList = "";
      if (s.tools.length > 0) {
        toolsList = `<div class="tools">${s.tools
          .map((t) => `<span class="tool-chip">${t.name}</span>`)
          .join("")}</div>`;
      }

      let errorDetail = "";
      if (s.status === "error" && s.error) {
        errorDetail = `<p class="error-msg">${s.error.substring(0, 120)}</p>`;
      }

      return `<div class="card card--${statusCfg.cls}" style="animation-delay:${i * 60}ms">
        <div class="card-row">
          <div class="card-icon">${statusCfg.icon}</div>
          <div class="card-body">
            <div class="card-name">${name}</div>
            <div class="card-status">${statusCfg.label}</div>
          </div>
          ${action}
        </div>
        ${toolsList}${errorDetail}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#DE332C">
<title>MCP Onboarding &mdash; OpenClaw</title>
<style>
:root {
  --bg: oklch(0.985 0.005 85);
  --surface: #fff;
  --border: oklch(0.912 0.006 85);
  --border-hi: oklch(0.85 0.01 85);
  --text: oklch(0.145 0 0);
  --text-muted: oklch(0.556 0 0);
  --text-dim: oklch(0.7 0 0);
  --primary: oklch(0.674 0.215 31);
  --primary-fg: #fff;
  --green: oklch(0.6 0.17 155);
  --green-subtle: oklch(0.96 0.03 155);
  --amber: oklch(0.7 0.16 75);
  --amber-subtle: oklch(0.96 0.03 75);
  --red: oklch(0.577 0.245 27);
  --red-subtle: oklch(0.96 0.04 27);
  --muted: oklch(0.955 0.008 85);
  --radius: 0.625rem;
  --radius-md: calc(var(--radius) - 2px);
  --radius-xl: calc(var(--radius) + 6px);
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
  --shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
  --sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(0.145 0 0);
    --surface: oklch(0.2 0 0);
    --border: oklch(0.269 0 0);
    --border-hi: oklch(0.33 0 0);
    --text: oklch(0.985 0 0);
    --text-muted: oklch(0.65 0 0);
    --text-dim: oklch(0.45 0 0);
    --green-subtle: oklch(0.2 0.04 155);
    --amber-subtle: oklch(0.2 0.04 75);
    --red-subtle: oklch(0.2 0.04 27);
    --muted: oklch(0.2 0 0);
    --shadow-sm: 0 1px 2px rgba(0,0,0,.2);
    --shadow: 0 1px 3px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.2);
  }
}
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
html { -webkit-font-smoothing: antialiased; }
body {
  font-family: var(--sans);
  font-size: 14px;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
}

.shell {
  max-width: 520px;
  margin: 0 auto;
  padding: 48px 20px 40px;
}

/* Header */
.hdr { margin-bottom: 24px; }
h1 {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}
.hdr-sub {
  font-size: 14px;
  color: var(--text-muted);
}

/* Progress */
.prog {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.prog-track {
  flex: 1;
  height: 6px;
  background: var(--muted);
  border-radius: 3px;
  overflow: hidden;
}
.prog-bar {
  height: 100%;
  border-radius: 3px;
  background: var(--primary);
  transition: width .6s cubic-bezier(.4,0,.2,1);
}
.prog-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  white-space: nowrap;
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* Cards */
.cards { display: flex; flex-direction: column; gap: 10px; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
  transition: border-color .15s, box-shadow .15s;
  animation: card-in .3s ease both;
}
@keyframes card-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card--ok   { border-color: oklch(0.8 0.1 155); }
.card--auth { border-color: oklch(0.82 0.1 75); }
.card--err  { border-color: oklch(0.8 0.12 27); }

.card-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card-icon {
  width: 36px; height: 36px;
  border-radius: var(--radius);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  background: var(--muted);
  color: var(--text-muted);
}
.card--ok      .card-icon { background: var(--green-subtle); color: var(--green); }
.card--auth    .card-icon { background: var(--amber-subtle); color: var(--amber); }
.card--err     .card-icon { background: var(--red-subtle);   color: var(--red); }
.card--loading .card-icon { background: oklch(0.96 0.02 260); color: oklch(0.55 0.15 260); }

.card-body { flex: 1; min-width: 0; }
.card-name {
  font-size: 14px;
  font-weight: 600;
}
.card-status {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 1px;
}
.card--ok   .card-status { color: var(--green); }
.card--auth .card-status { color: var(--amber); }
.card--err  .card-status { color: var(--red); }

.card-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  transition: opacity .15s;
  flex-shrink: 0;
}
.card-action:hover { opacity: .9; }
.card-action svg { display: block; }

.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.tool-chip {
  font-size: 11px;
  font-weight: 500;
  color: var(--green);
  background: var(--green-subtle);
  padding: 2px 8px;
  border-radius: 9999px;
}
.error-msg {
  margin-top: 8px;
  font-size: 12px;
  color: var(--red);
  word-break: break-word;
}

/* Footer */
.ftr {
  margin-top: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.ftr-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--primary);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: .3; }
  50% { opacity: 1; }
}
</style></head><body>
<div class="shell">
  <div class="hdr">
    <h1>MCP Onboarding</h1>
    <p class="hdr-sub">${allDone ? "All services connected. You\u2019re ready to go." : "Connect your MCP services to get started."}</p>
  </div>

  <div class="prog">
    <div class="prog-track"><div class="prog-bar" style="width:${pct}%"></div></div>
    <span class="prog-label">${connectedCount}/${total}</span>
  </div>

  <div class="cards">${serverCards}</div>

  <p class="ftr"><span class="ftr-dot"></span>Live</p>
</div>
<script>
(function(){
  var SPIN='<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="3s" repeatCount="indefinite"/></circle></svg>';
  var LOCK='<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="2" width="8" height="6" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="10.5" r="1" fill="currentColor"/></svg>';
  var CHECK='<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l2 2 3.5-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CROSS='<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  var STATUS_CFG = {
    connected:     {cls:"ok",      label:function(d){return d.tools.length+" tools"}, icon:CHECK},
    awaiting_auth: {cls:"auth",    label:function(){return "Needs authorization"},    icon:LOCK},
    exchanging:    {cls:"loading", label:function(){return "Exchanging token"},       icon:SPIN},
    connecting:    {cls:"loading", label:function(){return "Connecting"},             icon:SPIN},
    error:         {cls:"err",     label:function(){return "Error"},                  icon:CROSS},
    pending:       {cls:"pending", label:function(){return "Initializing"},           icon:SPIN}
  };
  var prev = "";
  function poll(){
    fetch("/api/status").then(function(r){return r.json()}).then(function(data){
      var names = Object.keys(data);
      var connected = names.filter(function(n){return data[n].status==="connected"}).length;
      var total = names.length;
      var pct = total ? Math.round(connected/total*100) : 0;
      var bar = document.querySelector(".prog-bar");
      if(bar) bar.style.width = pct+"%";
      var lbl = document.querySelector(".prog-label");
      if(lbl) lbl.textContent = connected+"/"+total;
      var sub = document.querySelector(".hdr-sub");
      if(sub) sub.textContent = connected===total ? "All services connected. You\\u2019re ready to go." : "Connect your MCP services to get started.";
      var sig = JSON.stringify(data);
      if(sig === prev) return;
      prev = sig;
      var container = document.querySelector(".cards");
      if(!container) return;
      names.forEach(function(name, i){
        var d = data[name];
        var cfg = STATUS_CFG[d.status] || STATUS_CFG.pending;
        var card = container.children[i];
        if(!card) return;
        var cls = "card card--"+cfg.cls;
        if(card.className !== cls) card.className = cls;
        var icon = card.querySelector(".card-icon");
        if(icon) icon.innerHTML = cfg.icon;
        var st = card.querySelector(".card-status");
        if(st) st.textContent = cfg.label(d);
        var oldAction = card.querySelector(".card-action");
        if(d.status==="awaiting_auth" && d.authUrl){
          if(!oldAction){
            var a = document.createElement("a");
            a.className="card-action"; a.target="_blank"; a.href=d.authUrl;
            a.innerHTML='<span>Connect</span><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3h7v7M13 3L6 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            card.querySelector(".card-row").appendChild(a);
          } else { oldAction.href = d.authUrl; }
        } else if(oldAction){ oldAction.remove(); }
        var oldTools = card.querySelector(".tools");
        if(d.tools && d.tools.length > 0){
          var html = d.tools.map(function(t){return '<span class="tool-chip">'+t+'</span>'}).join("");
          if(oldTools){ oldTools.innerHTML = html; }
          else { var div=document.createElement("div"); div.className="tools"; div.innerHTML=html; card.appendChild(div); }
        } else if(oldTools){ oldTools.remove(); }
        var oldErr = card.querySelector(".error-msg");
        if(d.status==="error" && d.error){
          if(oldErr){ oldErr.textContent = d.error.substring(0,120); }
          else { var p=document.createElement("p"); p.className="error-msg"; p.textContent=d.error.substring(0,120); card.appendChild(p); }
        } else if(oldErr){ oldErr.remove(); }
      });
    }).catch(function(){});
  }
  setInterval(poll, 3000);
})();
</script>
</body></html>`;
}

function renderEmpty() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MCP Onboarding &mdash; OpenClaw</title>
<style>
:root { --bg:oklch(0.985 0.005 85); --text:oklch(0.145 0 0); --muted:oklch(0.556 0 0); }
@media(prefers-color-scheme:dark){ :root{ --bg:oklch(0.145 0 0); --text:oklch(0.985 0 0); --muted:oklch(0.65 0 0); } }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px;text-align:center}
h1{font-size:18px;font-weight:600;margin-bottom:6px}
p{font-size:14px;color:var(--muted);line-height:1.6}
</style></head><body>
<div><h1>MCP Onboarding</h1><p>No MCP servers configured.</p></div>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const cbMatch = url.pathname.match(/^\/callback\/(.+)$/);
  if (cbMatch) {
    const name = cbMatch[1];
    const code = url.searchParams.get("code");
    if (state[name] && code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:oklch(0.985 0.005 85);--text:oklch(0.145 0 0);--muted:oklch(0.556 0 0);--green:oklch(0.6 0.17 155);--green-bg:oklch(0.96 0.03 155)}
@media(prefers-color-scheme:dark){:root{--bg:oklch(0.145 0 0);--text:oklch(0.985 0 0);--muted:oklch(0.65 0 0);--green-bg:oklch(0.2 0.04 155)}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{text-align:center;animation:in .35s ease}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.icon{width:48px;height:48px;margin:0 auto 14px;border-radius:0.625rem;background:var(--green-bg);display:flex;align-items:center;justify-content:center;color:var(--green)}
h1{font-size:16px;font-weight:600;margin-bottom:4px}
p{font-size:13px;color:var(--muted)}
</style></head><body>
<div class="wrap">
<div class="icon"><svg width="22" height="22" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l2 2 3.5-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>${name} connected</h1>
<p>Credentials saved. Closing automatically\u2026</p>
</div>
<script>setTimeout(()=>window.close(),2500)</script>
</body></html>`);
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
      summary[name] = {
        status: s.status,
        tools: s.tools.map((t) => t.name),
        error: s.error,
        authUrl: s.authUrl || null,
      };
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
