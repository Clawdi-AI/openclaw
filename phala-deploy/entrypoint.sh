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

EXEC_APPROVALS_FILE="/root/.openclaw/exec-approvals.json"
if [ ! -f "$EXEC_APPROVALS_FILE" ]; then
  cat >"$EXEC_APPROVALS_FILE" <<'EOF'
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full"
  },
  "agents": {}
}
EOF
  chmod 600 "$EXEC_APPROVALS_FILE"
  echo "Exec approvals written to $EXEC_APPROVALS_FILE"
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

# Start SSH daemon if installed (full image only)
if [ -x /usr/sbin/sshd ]; then
  mkdir -p /var/run/sshd /root/.ssh
  chmod 700 /root/.ssh 2>/dev/null || true
  chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
  /usr/sbin/sshd
  echo "SSH daemon started."
fi

# Start Docker daemon only when explicitly enabled (e.g. Phala CVM).
# k3s pods don't need Docker — the agent runs directly on the host.
if [ "${ENABLE_DOCKER:-}" = "1" ]; then
  rm -f /var/run/docker.pid /var/run/containerd/containerd.pid
  dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs &
  DOCKERD_PID=$!

  echo "Waiting for Docker daemon..."
  DOCKER_WAIT=0
  while ! docker info >/dev/null 2>&1; do
    sleep 1
    DOCKER_WAIT=$((DOCKER_WAIT + 1))
    if [ $DOCKER_WAIT -ge 30 ]; then
      echo "Warning: Docker daemon not ready after 30s, continuing without it."
      break
    fi
    if ! kill -0 $DOCKERD_PID 2>/dev/null; then
      echo "Warning: Docker daemon exited, continuing without it."
      break
    fi
  done
  if docker info >/dev/null 2>&1; then
    echo "Docker daemon ready."
  fi
else
  echo "Docker daemon disabled (set ENABLE_DOCKER=1 to enable)."
fi

# Gateway supervision (keep container alive for SSH even if gateway fails).
GATEWAY_RESTART_DELAY="${OPENCLAW_GATEWAY_RESTART_DELAY:-5}"
GATEWAY_RESTART_MAX_DELAY="${OPENCLAW_GATEWAY_RESTART_MAX_DELAY:-60}"
GATEWAY_RESET_AFTER="${OPENCLAW_GATEWAY_RESET_AFTER:-600}"

backoff="$GATEWAY_RESTART_DELAY"
set +e
while true; do
  echo "Starting OpenClaw gateway..."
  start_time=$(date +%s)
  openclaw gateway run --bind lan --port 18789 --force
  exit_code=$?
  end_time=$(date +%s)
  runtime=$((end_time - start_time))
  echo "Gateway exited with code ${exit_code}."

  # Kill orphaned openclaw children from the previous run so they don't
  # accumulate across restarts (especially under OOM pressure).
  pkill -9 -x openclaw 2>/dev/null || true

  if [ "$runtime" -ge "$GATEWAY_RESET_AFTER" ]; then
    backoff="$GATEWAY_RESTART_DELAY"
    echo "Gateway ran for ${runtime}s; resetting backoff to ${backoff}s."
  else
    if [ "$backoff" -lt 1 ]; then
      backoff=1
    fi
    if [ "$backoff" -lt "$GATEWAY_RESTART_MAX_DELAY" ]; then
      backoff=$((backoff * 2))
      if [ "$backoff" -gt "$GATEWAY_RESTART_MAX_DELAY" ]; then
        backoff="$GATEWAY_RESTART_MAX_DELAY"
      fi
    fi
  fi

  echo "Restarting gateway in ${backoff}s..."
  sleep "$backoff"
done
