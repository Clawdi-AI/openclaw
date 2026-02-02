#!/bin/sh
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw}"
SQLITE_LOCAL_DIR="/data/openclaw-local/sqlite"

# --- Derive keys from MASTER_KEY via HKDF-SHA256 ---
# One master secret derives: rclone crypt password, crypt salt, gateway auth token.
# S3 credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are provider-issued and stay separate.
if [ -n "$MASTER_KEY" ]; then
  echo "Deriving keys from MASTER_KEY..."
  derive_key() {
    node -e "
      const c = require('crypto');
      const key = c.hkdfSync('sha256', process.argv[1], '', process.argv[2], 32);
      process.stdout.write(Buffer.from(key).toString('base64'));
    " "$MASTER_KEY" "$1"
  }

  # Derive and obscure rclone crypt passwords (rclone needs its own obscured format)
  RCLONE_CRYPT_PASSWORD=$(rclone obscure "$(derive_key rclone-crypt-password)")
  RCLONE_CRYPT_PASSWORD2=$(rclone obscure "$(derive_key rclone-crypt-salt)")
  GATEWAY_AUTH_TOKEN=$(derive_key gateway-auth-token | tr -d '/+=' | head -c 32)

  export RCLONE_CRYPT_PASSWORD RCLONE_CRYPT_PASSWORD2 GATEWAY_AUTH_TOKEN
  echo "Keys derived (crypt password, crypt salt, gateway token)."
fi

# --- Encrypted S3 storage via rclone crypt + mount ---
if [ -n "$S3_BUCKET" ]; then
  echo "S3 storage configured (bucket: $S3_BUCKET), setting up rclone..."

  S3_PREFIX="${S3_PREFIX:-openclaw-state}"
  S3_REGION="${S3_REGION:-us-east-1}"

  # Generate rclone config from env vars
  mkdir -p /root/.config/rclone
  cat > /root/.config/rclone/rclone.conf <<RCONF
[s3]
type = s3
provider = ${S3_PROVIDER:-Other}
env_auth = true
endpoint = ${S3_ENDPOINT}
region = ${S3_REGION}
no_check_bucket = true

[s3-crypt]
type = crypt
remote = s3:${S3_BUCKET}/${S3_PREFIX}
password = ${RCLONE_CRYPT_PASSWORD}
password2 = ${RCLONE_CRYPT_PASSWORD2:-}
filename_encryption = standard
directory_name_encryption = true
RCONF

  # Local dir for SQLite files (can't run on FUSE)
  mkdir -p "$SQLITE_LOCAL_DIR"

  # Restore memory.db files from S3 before mount
  echo "Restoring SQLite files from S3..."
  rclone copy s3-crypt:sqlite/ "$SQLITE_LOCAL_DIR/" 2>/dev/null || true

  # Mount encrypted S3 as state dir
  mkdir -p "$STATE_DIR"
  rclone mount s3-crypt: "$STATE_DIR" \
    --vfs-cache-mode writes \
    --vfs-write-back 5s \
    --dir-cache-time 30s \
    --vfs-cache-max-size 500M \
    --allow-other \
    --daemon

  # Wait for mount
  echo "Waiting for rclone mount..."
  MOUNT_WAIT=0
  while ! mountpoint -q "$STATE_DIR"; do
    sleep 0.5
    MOUNT_WAIT=$((MOUNT_WAIT + 1))
    if [ $MOUNT_WAIT -ge 20 ]; then
      echo "ERROR: rclone mount not ready after 10s, aborting."
      exit 1
    fi
  done
  echo "rclone mount ready at $STATE_DIR"

  # Start periodic SQLite backup to S3 (every 60s)
  (
    while true; do
      sleep 60
      rclone copy "$SQLITE_LOCAL_DIR/" s3-crypt:sqlite/ 2>/dev/null || true
    done
  ) &
  SQLITE_BACKUP_PID=$!
  echo "SQLite backup loop started (PID $SQLITE_BACKUP_PID)"
else
  mkdir -p "$STATE_DIR"
fi

# Bootstrap minimal config if none exists
CONFIG_FILE="$STATE_DIR/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
  # Use derived gateway token if available, otherwise generate random
  BOOT_TOKEN="${GATEWAY_AUTH_TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)}"
  cat > "$CONFIG_FILE" <<CONF
{"gateway":{"mode":"local","bind":"lan","auth":{"token":"$BOOT_TOKEN"},"controlUi":{"dangerouslyDisableDeviceAuth":true}},"update":{"checkOnStart":false},"agents":{"defaults":{"memorySearch":{"provider":"openai","model":"qwen/qwen3-embedding-8b","remote":{"baseUrl":"https://api.redpill.ai/v1"},"fallback":"none"}}}}
CONF
  echo "Created default config at $CONFIG_FILE (token: ${GATEWAY_AUTH_TOKEN:+derived}${GATEWAY_AUTH_TOKEN:-random})"
fi

# --- SQLite symlink helper ---
# Called after gateway creates agent dirs to redirect memory.db to local storage
setup_sqlite_symlinks() {
  if [ -z "$S3_BUCKET" ]; then return; fi
  for agent_dir in "$STATE_DIR"/agents/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id=$(basename "$agent_dir")
    local_db="$SQLITE_LOCAL_DIR/${agent_id}-memory.db"
    target_db="${agent_dir}memory.db"
    # If real file exists on mount, move it to local
    if [ -f "$target_db" ] && [ ! -L "$target_db" ]; then
      cp "$target_db" "$local_db" 2>/dev/null || true
      rm -f "$target_db"
    fi
    # Create symlink if not already there
    if [ ! -L "$target_db" ]; then
      # Ensure local db exists (may have been restored from S3)
      touch "$local_db"
      ln -sf "$local_db" "$target_db"
    fi
  done
}

# Start SSH daemon first (always available for debugging)
mkdir -p /var/run/sshd /root/.ssh
chmod 700 /root/.ssh 2>/dev/null || true
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
/usr/sbin/sshd
echo "SSH daemon started."

# Clean up stale PID files from previous container restarts
rm -f /var/run/docker.pid /var/run/containerd/containerd.pid

# Start Docker daemon in background (best-effort, not critical for gateway)
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
  # Check if dockerd process died
  if ! kill -0 $DOCKERD_PID 2>/dev/null; then
    echo "Warning: Docker daemon exited, continuing without it."
    break
  fi
done
if docker info >/dev/null 2>&1; then
  echo "Docker daemon ready."
fi

# Set up SQLite symlinks (run once now, then periodically for new agents)
setup_sqlite_symlinks
if [ -n "$S3_BUCKET" ]; then
  (
    while true; do
      sleep 30
      setup_sqlite_symlinks
    done
  ) &
fi

# Start openclaw gateway (foreground)
exec openclaw gateway run --bind lan --port 18789 --force
