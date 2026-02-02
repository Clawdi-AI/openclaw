# Migration: New Storage Structure (2026-02-04)

## Status: ✅ COMPLETE (2026-02-05)

Migration completed successfully. New storage structure is live with:

- S3 FUSE mount at `/data`
- Home symlinks (`~/.openclaw → /data/openclaw`, `~/.config → /data/.config`)
- Secrets managed via Redpill Vault (`rv`)
- Docker image: `h4x3rotab/openclaw-cvm@sha256:f0e1c170b5f122753011c1cfb47c939dbec2f65e1f1ead64a3c4c912615b39a2`

## Background Context

### CVM Details

- **CVM Name**: `openclaw-dev`
- **CVM ID**: `0cd515c5-ef55-4f8a-8adf-9bc71318ff8e`
- **App ID**: `43069de20638d656a2d0e49fb074bee1049bc90e`
- **Gateway**: `dstack-pha-prod9.phala.network`
- **SSH Host**: `43069de20638d656a2d0e49fb074bee1049bc90e-1022.dstack-pha-prod9.phala.network`
- **Dashboard URL**: `https://43069de20638d656a2d0e49fb074bee1049bc90e-18789.dstack-pha-prod9.phala.network`
- **Gateway Auth Token**: `<stored-in-vault>` (from config, not HKDF-derived)

### Why This Migration

1. **Problem**: Plugins store data in `~/.config` which was NOT persisted to S3
2. **Solution**: Mount S3/volume at `/data` (parent dir) and symlink:
   - `~/.openclaw` → `/data/openclaw`
   - `~/.config` → `/data/.config`
3. **Benefit**: No more `OPENCLAW_STATE_DIR` env var needed - default `~/.openclaw` just works

### Old Structure

```
S3 prefix: openclaw-state
Mount: /data/openclaw
Env: OPENCLAW_STATE_DIR=/data/openclaw
```

### New Structure

```
S3 prefix: openclaw-data
Mount: /data
Symlinks:
  ~/.openclaw → /data/openclaw
  ~/.config → /data/.config
No env var needed
```

## Files Changed

### phala-deploy/entrypoint.sh

- Changed `DATA_DIR="/data"` (was `/data/openclaw`)
- Changed `SQLITE_LOCAL_DIR="/data-local/sqlite"` (was `/data/openclaw-local/sqlite`)
- Changed `S3_PREFIX` default to `openclaw-data` (was `openclaw-state`)
- Rclone config now writes to `/tmp/rclone/rclone.conf` (not `~/.config/rclone`)
- Added symlink creation after mount:
  ```sh
  ln -sfn "$DATA_DIR/openclaw" /root/.openclaw
  ln -sfn "$DATA_DIR/.config" /root/.config
  ```
- Config file path changed to `/root/.openclaw/openclaw.json`

### phala-deploy/Dockerfile

- Removed `ENV OPENCLAW_STATE_DIR=/data/openclaw`
- Removed `export OPENCLAW_STATE_DIR=/data/openclaw` from `.bashrc`

### phala-deploy/docker-compose.yml

- Volume mount changed: `openclaw_data:/data` (was `openclaw_state:/data/openclaw`)
- Removed `OPENCLAW_STATE_DIR` environment variable
- Changed `S3_PREFIX` default to `openclaw-data`
- Renamed volume from `openclaw_state` to `openclaw_data`

## Backup Location

```
/home/h4x/tmp/openclaw/phala-deploy/backup/2026-02-04/
├── openclaw/    # Full /data/openclaw backup (2.5MB)
└── .config/     # /root/.config backup
```

## Migration Steps

### Step 1: Push New Image ✅ DONE

```bash
docker build -f phala-deploy/Dockerfile -t h4x3rotab/openclaw-cvm:latest .
docker push h4x3rotab/openclaw-cvm:latest
```

Pushed digest: `sha256:f0e1c170b5f122753011c1cfb47c939dbec2f65e1f1ead64a3c4c912615b39a2`

### Step 2: Get Digest and Update docker-compose.yml ✅ DONE

Updated `docker-compose.yml` with new digest.

### Step 3: Redeploy to Phala ✅ DONE

Secrets now managed via Redpill Vault (`rv`). Deploy using:

```bash
cd phala-deploy
rv-exec --dotenv /tmp/deploy.env \
  MASTER_KEY S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY REDPILL_API_KEY \
  -- phala deploy --cvm-id 0cd515c5-ef55-4f8a-8adf-9bc71318ff8e \
  -c docker-compose.yml -e /tmp/deploy.env
```

### Step 4: Wait for New Container ✅ DONE

```bash
phala cvms logs 0cd515c5-ef55-4f8a-8adf-9bc71318ff8e
```

Confirmed logs showed:

- "rclone FUSE mount ready at /data"
- "Home symlinks created (~/.openclaw, ~/.config → /data)"
- "SSH daemon started"

### Step 5: Restore Backup ✅ DONE

```bash
# CVM_SSH_HOST is now stored in Redpill Vault
rv set CVM_SSH_HOST  # value: 43069de20638d656a2d0e49fb074bee1049bc90e-1022.dstack-pha-prod9.phala.network

# Push backup in parts (cvm-scp can timeout on large transfers)
cd phala-deploy/backup/2026-02-04/openclaw/openclaw
for dir in agents credentials devices identity telegram canvas cron logs media memory sqlite workspace; do
  tar -cf - "$dir" | ssh ... "tar -xf - -C /data/openclaw/"
done
```

### Step 6: Verify ✅ DONE

```bash
./phala-deploy/cvm-exec 'ls -la /root/.openclaw /root/.config'
# Shows symlinks: /root/.openclaw -> /data/openclaw

./phala-deploy/cvm-exec 'mount | grep fuse.rclone'
# Shows: s3-crypt: on /data type fuse.rclone

./phala-deploy/cvm-exec 'openclaw channels status --probe'
# Shows: Gateway reachable, Telegram enabled + running
```

### Step 7: Re-pair Nodes (if needed)

Backup restored device pairings. No re-pairing needed.

## S3 Data

- **Old prefix**: `openclaw-state` - untouched, can recover if needed
- **New prefix**: `openclaw-data` - fresh start with new structure

## Node Host Setup (for reference)

Local node connects to gateway:

```bash
OPENCLAW_GATEWAY_TOKEN=<your-gateway-token> openclaw node run \
  --host <app_id>-18789.<gateway>.phala.network \
  --port 443 \
  --tls \
  --display-name "Local Node"
```

Node stores identity in `~/.openclaw/node.json`. Delete this file to force fresh pairing.

Approve on gateway:

```bash
./phala-deploy/cvm-exec 'openclaw devices list'
./phala-deploy/cvm-exec 'openclaw devices approve <requestId>'
```

## Known Issues Found This Session

1. **`openclaw devices list` doesn't show pending nodes** - but they exist in `/data/devices/pending.json`. Approve by reading the JSON directly or checking it multiple times.

2. **Kimi K2.5 503 errors** - Redpill infrastructure issue, model temporarily unavailable. Fallback to GLM 4.7.

3. **Agent tool call failures** - Agent hallucinated file paths, used wrong Telegram targets. Model quality issue, not infrastructure.

4. **PDF files exist but weren't sent** - Agent generated PDFs at `/root/.openclaw/workspace/` but failed to send via Telegram (wrong target format).

## Current Model Config

- Primary: `openai-codex/gpt-5.2-codex` (OAuth)
- Fallbacks: All Redpill TEE models (GLM 4.7, Kimi K2.5, DeepSeek, etc.)
- Memory search: `qwen/qwen3-embedding-8b` via Redpill API
