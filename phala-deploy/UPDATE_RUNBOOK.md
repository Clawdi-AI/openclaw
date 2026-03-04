# Phala Update Runbook (OpenClaw + mux-server)

This is the dedicated, repeatable update procedure for the two-CVM deployment:

- one CVM runs `openclaw`
- one CVM runs `mux-server`

Do not run both services in one CVM.

## Invariants

1. Keep roles separate:
   - OpenClaw CVM uses `phala-deploy/docker-compose.yml`
   - mux CVM deploy/update is documented in `mux-server/deploy/README.md`
2. Keep images digest-pinned in compose.
3. `MUX_REGISTER_KEY` must match OpenClaw `gateway.http.endpoints.mux.registerKey`.
4. OpenClaw must have `gateway.http.endpoints.mux.inboundUrl` set to a public URL reachable by mux.
5. OpenClaw device identity is stable when `MASTER_KEY` is stable:
   - `openclawId` is the device `deviceId` from `/root/.openclaw/identity/device.json`
   - when `MASTER_KEY` is set, OpenClaw derives the device keypair deterministically, so deleting `device.json` is recoverable after restart

## Required script args

- `deploy-openclaw.sh`: requires both `--openclaw-cvm <name>` and `--mux-cvm <name>`
- Mux script args and usage: `mux-server/deploy/README.md`

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

Mux deploy env and proxy access-control setup are documented in:

- `mux-server/deploy/README.md`

Deploy:

```bash
# OpenClaw
phala deploy \
  --cvm-id <openclaw-cvm-name> \
  -c phala-deploy/docker-compose.yml \
  -e /tmp/openclaw-phala-deploy.env

# mux-server
# See mux-server/deploy/README.md
```

Pairing-token issuance and admin API access are documented in:

- `mux-server/deploy/README.md`

## Update flow with a local env file

If you have a local secrets file (e.g., `configs/my-instance.env`):

### 1. Build the new images

```bash
./phala-deploy/build-openclaw.sh
# This builds and pushes full + base target images.
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
```

This validates required env vars and prints the deploy command without executing it.
For mux preflight, see `mux-server/deploy/README.md`.

### 2. Build images

OpenClaw:

```bash
./phala-deploy/build-openclaw.sh
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

```

For mux-server deploy/build/pairing flows, see `mux-server/deploy/README.md`.

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

### 5. Mux-server ops

All mux-server deployment, pairing-token, and troubleshooting procedures are maintained in:

- `mux-server/deploy/README.md`

## Related files

- `phala-deploy/deploy-openclaw.sh`
- `mux-server/deploy/README.md`
