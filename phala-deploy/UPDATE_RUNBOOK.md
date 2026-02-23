# Phala Update Runbook (OpenClaw + mux-server)

This is the dedicated, repeatable update procedure for the two-CVM deployment:

- one CVM runs `openclaw`
- one CVM runs `mux-server`

Do not run both services in one CVM.

## Invariants

1. Keep roles separate:
   - OpenClaw CVM uses `phala-deploy/docker-compose.yml`
   - mux CVM uses `phala-deploy/mux-server-compose.yml`
2. Keep images digest-pinned in compose.
3. `MUX_REGISTER_KEY` must match OpenClaw `gateway.http.endpoints.mux.registerKey`.
4. OpenClaw must have `gateway.http.endpoints.mux.inboundUrl` set to a public URL reachable by mux.
5. OpenClaw device identity is stable when `MASTER_KEY` is stable:
   - `openclawId` is the device `deviceId` from `/root/.openclaw/identity/device.json`
   - when `MASTER_KEY` is set, OpenClaw derives the device keypair deterministically, so deleting `device.json` is recoverable after restart

## Required script args

- `deploy-openclaw.sh`: requires both `--openclaw-cvm <name>` and `--mux-cvm <name>`
- `deploy-mux.sh`: requires `--mux-cvm <name>`; `--openclaw-cvm <name>` is required when smoke tests run (default and `--test-only`), optional with `--skip-test`
- `mux-pair-token.sh`: requires both `--openclaw-cvm <name>` and `--mux-cvm <name>`

## Manual env-file flow

Use local `.env` files with `phala deploy`-compatible key/value pairs.
Keep these files out of git and set strict permissions.

Create OpenClaw deploy env (example):

```bash
cat >/tmp/openclaw-phala-deploy.env <<'EOF'
MASTER_KEY=replace-with-master-key
REDPILL_API_KEY=replace-with-redpill-key
S3_BUCKET=replace-with-bucket
S3_ENDPOINT=replace-with-s3-endpoint
S3_PROVIDER=Other
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=replace-with-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-secret-access-key
EOF
chmod 600 /tmp/openclaw-phala-deploy.env
```

Create mux deploy env (example):

```bash
cat >/tmp/mux-phala-deploy.env <<'EOF'
MUX_REGISTER_KEY=replace-with-shared-register-key
MUX_ADMIN_TOKEN=replace-with-mux-admin-token
TELEGRAM_BOT_TOKEN=replace-with-telegram-token
DISCORD_BOT_TOKEN=replace-with-discord-token
EOF
chmod 600 /tmp/mux-phala-deploy.env
```

Deploy:

```bash
# OpenClaw
phala deploy \
  --cvm-id <openclaw-cvm-name> \
  -c phala-deploy/docker-compose.yml \
  -e /tmp/openclaw-phala-deploy.env

# mux-server
phala deploy \
  --cvm-id <mux-cvm-name> \
  -c phala-deploy/mux-server-compose.yml \
  -e /tmp/mux-phala-deploy.env
```

Generate pairing token:

```bash
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token
./phala-deploy/mux-pair-token.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev \
  telegram agent:main:main
```

## Update flow with a local env file

If you have a local secrets file (e.g., `configs/my-instance.env`):

### 1. Build and pin the new image

```bash
./phala-deploy/build-pin-openclaw.sh
# This pushes full + base target images, updates docker-compose.yml with the full image, and writes:
#   phala-deploy/image-refs/openclaw-base-image.ref
#   phala-deploy/image-refs/openclaw-full-image.ref
```

### 2. Download the existing config

The config on the data volume persists across deploys. Download it so you can pass it back as `OPENCLAW_CONFIG_B64`:

```bash
phala ssh <cvm-name> -- docker cp openclaw:/root/.openclaw/openclaw.json /tmp/openclaw.json
phala cp <cvm-name>:/tmp/openclaw.json ./openclaw.json
```

### 3. Build the deploy env file

Combine your secrets with the base64-encoded config:

```bash
OPENCLAW_CONFIG_B64=$(base64 -w0 ./openclaw.json)

# Start with your secrets
cp configs/my-instance.env /tmp/deploy.env
chmod 600 /tmp/deploy.env

# Append the config (add REDPILL_API_KEY if not in your env file)
echo "OPENCLAW_CONFIG_B64=${OPENCLAW_CONFIG_B64}" >> /tmp/deploy.env
```

The env file needs at minimum: `MASTER_KEY`, `OPENCLAW_CONFIG_B64`. Add `REDPILL_API_KEY` and S3 vars as needed.

### 4. Deploy

```bash
phala deploy --cvm-id <cvm-name> \
  -c phala-deploy/docker-compose.yml \
  -e /tmp/deploy.env
```

### 5. Wait and verify

Image pulls can take 5-10 minutes on a node that hasn't cached the image.

```bash
# Check CVM status (starting → running)
phala cvms list

# Once running, check entrypoint logs
phala ssh <cvm-name> -- docker logs openclaw 2>&1 \
  | grep -iE '(mcporter|Starting|Keys derived|error)'
```

Expected output:

```
Keys derived (gateway token, crypt password, crypt salt).
mcporter config written for Composio MCP (standalone mode).
Starting OpenClaw gateway...
```

## Standard update flow

### 1. Preflight

```bash
bash phala-deploy/deploy-openclaw.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --dry-run
bash phala-deploy/deploy-mux.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --dry-run
```

This validates required env vars and prints the deploy commands without executing them.

### 2. Build and pin images

OpenClaw:

```bash
./phala-deploy/build-pin-openclaw.sh
```

mux-server (only when mux changed):

```bash
./phala-deploy/build-pin-mux.sh
```

### 3. Deploy

```bash
# Deploy OpenClaw (set env vars first)
export MASTER_KEY=replace-with-master-key
export REDPILL_API_KEY=replace-with-redpill-key
export S3_BUCKET=replace-with-bucket
export S3_ENDPOINT=replace-with-s3-endpoint
export S3_PROVIDER=Other
export S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=replace-with-access-key-id
export AWS_SECRET_ACCESS_KEY=replace-with-secret-access-key
export MUX_REGISTER_KEY=replace-with-shared-register-key
bash phala-deploy/deploy-openclaw.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev

# Deploy mux-server (set env vars first)
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token
export TELEGRAM_BOT_TOKEN=replace-with-telegram-token
export DISCORD_BOT_TOKEN=replace-with-discord-token
bash phala-deploy/deploy-mux.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev
```

Each script deploys its CVM, waits for health, and runs smoke tests. They can be run independently.

### 4. Verify runtime

OpenClaw CVM:

```bash
phala ssh <openclaw-cvm-name> -- docker exec openclaw openclaw --version
phala ssh <openclaw-cvm-name> -- docker exec openclaw openclaw channels status --probe
```

mux CVM:

```bash
curl -fsS https://<mux-app-id>-18891.<gateway-domain>/health
phala logs mux-server --cvm-id <mux-cvm-name> --tail 120
```

Transient behavior note:

- During/just after rollout, container SSH may briefly fail (for example `Connection closed by UNKNOWN port 65535`) while Docker/app services are restarting.
- Rollout usually has two phases:
  1. CVM reboot/reconcile (~2 minutes)
  2. image pull + compose start (can take a few more minutes)
- Treat this as transient first, not immediate config breakage.
- Do **not** force-start old containers with `docker start openclaw` during this window; wait for compose reconciliation first.
- Verification order:
  1. Check control plane first: `phala cvms get <openclaw-app-id> --json` and confirm status `running` + expected image in compose.
  2. Watch serial logs for real progress (instead of guessing):
     `phala logs --serial --cvm-id <openclaw-cvm-name> -f`
  3. During image pull/startup, `docker ps` may still show the old container/image for a while; wait for pull/recreate to complete.
  4. After serial logs show compose completion, verify:
     `phala ssh <openclaw-cvm-name> -- docker exec openclaw openclaw --version`
  5. If manual recovery is needed, use compose + env-file (not `docker start`):
     `phala ssh <openclaw-cvm-name> -- docker compose -f /dstack/docker-compose.yaml --env-file /dstack/.host-shared/.decrypted-env up -d`

### 5. Pairing smoke check

Pairing token generation is target-driven:

- use OpenClaw session target (`sessionKey`) to choose where the conversation lands
- do not use inbound sender identity to select OpenClaw target

Issue pairing token (admin token):

```bash
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token
./phala-deploy/mux-pair-token.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev \
  telegram agent:main:main
```

## Fast fixes for known failures

### Telegram/Discord inbound not working

Cause: missing `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` in mux deploy env.

Fix:

1. Ensure `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` are exported.
2. Re-run: `bash phala-deploy/deploy-mux.sh --openclaw-cvm <openclaw-cvm-name> --mux-cvm <mux-cvm-name>`

### Telegram `/bot_status` gets no response, mux logs show `getUpdates failed (409)`

Cause: another poller is using the same Telegram bot token (most often a local `phala-deploy/local-mux-e2e` stack).

How to confirm:

1. Check mux health details:
   - `curl -fsS https://<mux-app-id>-18891.<gateway-domain>/health | jq .`
   - degraded state shows `telegramInbound.code = "poll_conflict"`.
2. Check logs:
   - `phala logs mux-server --cvm-id <mux-cvm-name> --tail 120`

Fix:

1. Stop the competing poller (local e2e example):
   - `./phala-deploy/local-mux-e2e/scripts/down.sh`
2. Ensure only one long-poller runs for this bot token.
3. Re-check logs/health to confirm conflict is gone.

### mux healthy but no messages forwarded to OpenClaw

Cause: either no pairing binding yet, or the OpenClaw instance has not registered a reachable `inboundUrl`.

Fix:

1. Verify OpenClaw mux config (OpenClaw CVM):
   - `gateway.http.endpoints.mux.baseUrl`
   - `gateway.http.endpoints.mux.registerKey`
   - `gateway.http.endpoints.mux.inboundUrl` (must be public/reachable by mux)
2. Generate a fresh pairing token and pair again:
   - `./phala-deploy/mux-pair-token.sh --openclaw-cvm <openclaw-cvm-name> --mux-cvm <mux-cvm-name> telegram agent:main:main`
3. Check mux logs for `instance_registered` and `*_inbound_forwarded` / `*_inbound_retry_deferred`.

### mux startup error: `UNIQUE constraint failed: tenants.api_key_hash`

Cause: stale mux DB tenant rows conflict with current bootstrap seed.

Fix:

1. SSH to the mux CVM host and clear mux state volume:
   - `phala ssh <mux-cvm-name> -- docker rm -f mux-server || true`
   - `phala ssh <mux-cvm-name> -- docker volume rm -f mux_data || true`
2. Re-run: `bash phala-deploy/deploy-mux.sh --openclaw-cvm <openclaw-cvm-name> --mux-cvm <mux-cvm-name>`

## Related files

- `phala-deploy/deploy-openclaw.sh`
- `phala-deploy/deploy-mux.sh`
- `phala-deploy/mux-pair-token.sh`
- `phala-deploy/mux-server-compose.yml`
