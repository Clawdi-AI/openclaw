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
3. `MUX_API_KEY` must match OpenClaw `gateway.http.endpoints.mux.token`.
4. After mux DB reset/new DB bootstrap, sync mux inbound target again.

## One-time local setup

```bash
cp phala-deploy/cvm-rollout-targets.env.example phala-deploy/.env.rollout-targets
```

Edit `phala-deploy/.env.rollout-targets`:

- `PHALA_OPENCLAW_CVM_IDS`
- `PHALA_MUX_CVM_IDS`

Load before update commands:

```bash
set -a
source phala-deploy/.env.rollout-targets
set +a
```

## No-rv fallback (manual .env files)

If `rv-exec` is unavailable, use local `.env` files with `phala deploy`-compatible key/value pairs.
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
MUX_API_KEY=replace-with-shared-mux-api-key
TELEGRAM_BOT_TOKEN=replace-with-telegram-token
DISCORD_BOT_TOKEN=replace-with-discord-token
EOF
chmod 600 /tmp/mux-phala-deploy.env
```

Deploy without `rv-exec`:

```bash
# OpenClaw
./phala-deploy/cvm-rollout.sh deploy \
  --cvm-ids "$PHALA_OPENCLAW_CVM_IDS" \
  --compose phala-deploy/docker-compose.yml \
  --env-file /tmp/openclaw-phala-deploy.env \
  --wait

# mux-server
./phala-deploy/cvm-rollout.sh deploy \
  --cvm-ids "$PHALA_MUX_CVM_IDS" \
  --compose phala-deploy/mux-server-compose.yml \
  --env-file /tmp/mux-phala-deploy.env \
  --wait
```

Set mux inbound target without `rv-exec` (manual API call):

```bash
export MUX_API_KEY=replace-with-shared-mux-api-key
MUX_BASE="https://<mux-app-id>-18891.<gateway-domain>"
OPENCLAW_INBOUND="https://<openclaw-app-id>-18789.<gateway-domain>/v1/mux/inbound"

payload="$(printf '{"inboundUrl":"%s","inboundTimeoutMs":15000}' "$OPENCLAW_INBOUND")"
curl -fsS -X POST "$MUX_BASE/v1/tenant/inbound-target" \
  -H "Authorization: Bearer $MUX_API_KEY" \
  -H "Content-Type: application/json" \
  --data "$payload"
echo

curl -fsS -H "Authorization: Bearer $MUX_API_KEY" \
  "$MUX_BASE/v1/tenant/inbound-target"
echo
```

## Standard update flow

### 1. Preflight

```bash
./phala-deploy/cvm-rollout-targets.sh all --dry-run
```

This validates role-to-CVM mapping by name (`mux` role requires CVM name containing `mux`).
It reads CVM metadata via `phala cvms get`.

### 2. Build and pin images

OpenClaw:

```bash
./phala-deploy/build-pin-image.sh
```

mux-server (only when mux changed):

```bash
./phala-deploy/build-pin-mux-image.sh
```

### 3. Roll out by role

OpenClaw first:

```bash
./phala-deploy/cvm-rollout-targets.sh openclaw --wait
```

Then mux:

```bash
./phala-deploy/cvm-rollout-targets.sh mux --wait
```

Or both in sequence:

```bash
./phala-deploy/cvm-rollout-targets.sh all --wait
```

### 4. Set inbound target wiring (required after mux deploy/reset)

```bash
./phala-deploy/set-inbound-target.sh
```

The script auto-derives:

- mux base URL: `https://<mux-app-id>-18891.<gateway>`
- OpenClaw inbound URL: `https://<openclaw-app-id>-18789.<gateway>/v1/mux/inbound`

It then sets `POST /v1/tenant/inbound-target` using `rv-exec MUX_API_KEY`.
By default it reads CVM IDs from `PHALA_MUX_CVM_IDS` and `PHALA_OPENCLAW_CVM_IDS`.
If either variable has multiple IDs, pass explicit `--mux-cvm-id` / `--openclaw-cvm-id`.

### 5. Verify runtime

OpenClaw CVM:

```bash
export CVM_SSH_HOST=<openclaw-app-id>-1022.<gateway-domain>
./phala-deploy/cvm-exec 'openclaw --version'
./phala-deploy/cvm-exec 'openclaw channels status --probe'
```

mux CVM:

```bash
curl -fsS https://<mux-app-id>-18891.<gateway-domain>/health
phala logs mux-server --cvm-id <mux-cvm-uuid> --tail 120
```

Transient behavior note:

- During/just after rollout, container SSH may briefly fail (for example `Connection closed by UNKNOWN port 65535`) while Docker/app services are restarting.
- Treat this as transient first, not immediate config breakage.
- Verification order:
  1. Check control plane first: `phala cvms get <openclaw-app-id> --json` and confirm status `running` + expected image digest in compose.
  2. Retry `./phala-deploy/cvm-exec 'openclaw --version'` after a short wait.
  3. Only escalate to debugging if repeated retries still fail.

### 6. Pairing smoke check

Pairing token generation is target-driven:

- use OpenClaw session target (`sessionKey`) to choose where the conversation lands
- do not use inbound sender identity to select OpenClaw target
- Discord currently requires `routeKey` at issuance time to bind the DM user route safely

Issue pairing token:

```bash
rv-exec MUX_API_KEY -- bash -lc '
  MUX_BASE="https://<mux-app-id>-18891.<gateway-domain>"
  curl -sS -X POST "$MUX_BASE/v1/pairings/token" \
    -H "Authorization: Bearer $MUX_API_KEY" \
    -H "Content-Type: application/json" \
    --data "{\"channel\":\"telegram\",\"sessionKey\":\"agent:main:main\",\"ttlSec\":900}"
  echo
'
```

Check active bindings:

```bash
rv-exec MUX_API_KEY -- bash -lc '
  MUX_BASE="https://<mux-app-id>-18891.<gateway-domain>"
  curl -sS -H "Authorization: Bearer $MUX_API_KEY" "$MUX_BASE/v1/pairings"
  echo
'
```

## Fast fixes for known failures

### mux crash loop on startup: missing bot token

Cause: `MUX_TELEGRAM_INBOUND_ENABLED=true` or `MUX_DISCORD_INBOUND_ENABLED=true` with missing token.

Fix:

1. Ensure `PHALA_MUX_DEPLOY_SECRETS` includes required keys.
2. Re-run:
   - `./phala-deploy/cvm-rollout-targets.sh mux --wait`

### mux healthy but no messages forwarded to OpenClaw

Cause: tenant inbound target missing in mux DB.

Fix:

```bash
./phala-deploy/set-inbound-target.sh
```

### mux startup error: `UNIQUE constraint failed: tenants.api_key_hash`

Cause: stale mux DB tenant rows conflict with current bootstrap seed.

Fix:

1. SSH to the mux CVM host and clear mux state volume:
   - `docker rm -f mux-server || true`
   - `docker volume rm -f mux_data || true`
2. Re-run mux rollout:
   - `./phala-deploy/cvm-rollout-targets.sh mux --wait`
3. Re-sync inbound target:
   - `./phala-deploy/set-inbound-target.sh`

## Related files

- `phala-deploy/cvm-rollout-targets.sh`
- `phala-deploy/cvm-rollout.sh`
- `phala-deploy/cvm-rollout-targets.env.example`
- `phala-deploy/set-inbound-target.sh`
- `phala-deploy/mux-server-compose.yml`
