#!/bin/sh
set -e

# Persistent storage root (Docker volume or k8s PVC)
DATA_DIR="/data"

# --- Derive gateway auth token from MASTER_KEY via HKDF-SHA256 ---
if [ -n "$MASTER_KEY" ]; then
  echo "Deriving keys from MASTER_KEY..."
  derive_key() {
    node -e "
      const c = require('crypto');
      const key = c.hkdfSync('sha256', process.argv[1], '', process.argv[2], 32);
      process.stdout.write(Buffer.from(key).toString('base64'));
    " "$MASTER_KEY" "$1"
  }

  GATEWAY_AUTH_TOKEN=$(derive_key gateway-auth-token | tr -d '/+=' | head -c 32)
  export GATEWAY_AUTH_TOKEN
  echo "Keys derived."
fi

# Ensure auth token has a fallback for dev/local use
export GATEWAY_AUTH_TOKEN="${GATEWAY_AUTH_TOKEN:-admin}"

mkdir -p "$DATA_DIR"

# --- Set up home directory symlinks ---
# ~/.openclaw → /data/openclaw (state dir)
# ~/.config → /data/.config (plugin configs)
ensure_symlink_dir() {
  target="$1"
  link="$2"

  mkdir -p "$target"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    if [ "$(ls -A "$link" 2>/dev/null)" ]; then
      find "$link" -mindepth 1 -maxdepth 1 -exec mv -t "$target" {} + || true
    fi
    rmdir "$link" 2>/dev/null || rm -rf "$link"
  fi
  ln -sfn "$target" "$link"
}

ensure_symlink_dir "$DATA_DIR/openclaw" /root/.openclaw
ensure_symlink_dir "$DATA_DIR/.config" /root/.config
ensure_symlink_dir "$DATA_DIR/.mcporter" /root/.mcporter
echo "Home symlinks created (~/.openclaw, ~/.config, ~/.mcporter → $DATA_DIR)"

# Bootstrap config from OPENCLAW_CONFIG_B64 (sent by clawdi control plane)
CONFIG_FILE="/root/.openclaw/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$OPENCLAW_CONFIG_B64" ]; then
    echo "Decoding config from OPENCLAW_CONFIG_B64..."
    printf '%s' "$OPENCLAW_CONFIG_B64" | base64 -d > "$CONFIG_FILE"
    echo "Config written to $CONFIG_FILE"
  else
    echo "Warning: No config file and no OPENCLAW_CONFIG_B64 set. Gateway may fail."
  fi
fi

# Bootstrap workspace files from OPENCLAW_WORKSPACE_FILES_B64 (first boot only).
# Skipped if workspace already has a .git dir (indicates gateway already initialized it).
WORKSPACE_DIR="/root/.openclaw/workspace"
if [ -n "$OPENCLAW_WORKSPACE_FILES_B64" ] && [ ! -d "$WORKSPACE_DIR/.git" ]; then
  echo "Decoding workspace files from OPENCLAW_WORKSPACE_FILES_B64..."
  mkdir -p "$WORKSPACE_DIR"
  printf '%s' "$OPENCLAW_WORKSPACE_FILES_B64" | base64 -d | node -e "
    const fs=require('fs'),path=require('path');
    const ws=process.argv[1];
    const files=JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
    for(const[n,c]of Object.entries(files)){
      const fp=path.resolve(ws,n);
      if(!fp.startsWith(ws + '/')){
        throw new Error('Invalid workspace file path: ' + n);
      }
      fs.mkdirSync(path.dirname(fp),{recursive:true});
      fs.writeFileSync(fp,c);
      console.log('Wrote',fp);
    }
  " "$WORKSPACE_DIR"
  echo "Workspace files written."
fi

# --- Configure mcporter for Composio MCP proxy ---
# Reads composio skill config from openclaw.json and writes mcporter config.
if [ -f "$CONFIG_FILE" ]; then
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const env = cfg.skills?.entries?.composio?.env || {};
    const url = env.COMPOSIO_MCP_URL || "";
    const token = env.COMPOSIO_MCP_TOKEN || "";
    const apiKey = env.COMPOSIO_API_KEY || "";

    let headers;
    if (url && token) {
      headers = { Authorization: "Bearer " + token };
    } else if (url && apiKey) {
      headers = { "x-api-key": apiKey };
    } else {
      if (url) console.log("Composio: COMPOSIO_MCP_URL set but no auth token/key — skipping mcporter config.");
      else console.log("Composio: not configured, skipping mcporter config.");
      process.exit(0);
    }

    const cfgPath = "/root/.mcporter/mcporter.json";
    let mcpCfg = { mcpServers: {}, imports: [] };
    try { mcpCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
    if (!mcpCfg.mcpServers) mcpCfg.mcpServers = {};
    mcpCfg.mcpServers["clawdi-mcp"] = { baseUrl: url, headers };
    fs.mkdirSync("/root/.mcporter", { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(mcpCfg, null, 2), { mode: 0o600 });
    console.log("mcporter config written for Composio MCP (" + (token ? "proxy" : "standalone") + " mode).");
  ' "$CONFIG_FILE" || true
fi

# --- Pre-seed device pairing for local CLI ---
# When MASTER_KEY is set the CLI's device identity is deterministic (HKDF-derived).
# Pre-approve it so local commands (healthcheck, channels status) don't block on
# manual pairing approval in the headless CVM.
PAIRED_JSON="/root/.openclaw/devices/paired.json"
if [ -n "$MASTER_KEY" ]; then
  mkdir -p "$(dirname "$PAIRED_JSON")"
  node -e '
    const c = require("crypto"), fs = require("fs");
    const mk = process.env.MASTER_KEY;
    const seed = Buffer.from(c.hkdfSync("sha256", mk, "", "openclaw-device-identity-v1", 32));
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privKey = c.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" });
    const pubKey = c.createPublicKey(privKey);
    const spki = pubKey.export({ type: "spki", format: "der" });
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const raw = spki.subarray(spkiPrefix.length);
    const deviceId = c.createHash("sha256").update(raw).digest("hex");
    const f = process.argv[1];
    let paired = {};
    try { paired = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    if (paired[deviceId]) { console.log("Device pairing already present (" + deviceId.slice(0, 12) + "...)"); process.exit(0); }
    const publicKey = raw.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const now = Date.now();
    paired[deviceId] = { deviceId, publicKey, displayName: "local-cvm", roles: ["operator"], scopes: ["operator.admin", "operator.approvals", "operator.pairing"], createdAtMs: now, approvedAtMs: now };
    fs.writeFileSync(f, JSON.stringify(paired, null, 2), { mode: 0o600 });
    console.log("Pre-seeded device pairing (" + deviceId.slice(0, 12) + "...)");
  ' "$PAIRED_JSON"
fi

# --- Prepare SSH directories ---
if [ "${ENABLE_SSH:-}" = "1" ] && [ -x /usr/sbin/sshd ]; then
  mkdir -p /var/run/sshd /root/.ssh
  chmod 700 /root/.ssh 2>/dev/null || true
  chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
fi

# --- Disable optional services unless explicitly enabled ---
# Configs are baked into the image; remove the ones that aren't wanted.
if [ "${ENABLE_SSH:-}" != "1" ]; then
  rm -f /etc/supervisor/conf.d/sshd.conf
  echo "SSH daemon disabled (set ENABLE_SSH=1 to enable)."
fi
if [ "${ENABLE_DOCKER:-}" = "1" ]; then
  rm -f /var/run/docker.pid /var/run/containerd/containerd.pid
else
  rm -f /etc/supervisor/conf.d/dockerd.conf
  echo "Docker daemon disabled (set ENABLE_DOCKER=1 to enable)."
fi

# Ensure log directories exist
mkdir -p "$DATA_DIR/openclaw/logs"   # gateway logs (user-visible, persistent)
mkdir -p /var/log/supervisor          # internal service logs (not persistent)

# Hand off to supervisord as PID 1
exec supervisord -n -c /etc/supervisor/supervisord.conf
