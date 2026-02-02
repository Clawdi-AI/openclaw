# Deploy OpenClaw on Phala Cloud

Run an OpenClaw gateway inside a Phala Confidential VM (CVM) with encrypted S3-backed storage. The CVM is stateless — all state lives in S3, encrypted client-side, so you can destroy and recreate the VM without losing data.

## Prerequisites

- A [Phala Cloud](https://cloud.phala.com) account
- The [Phala CLI](https://docs.phala.network/cli) installed: `npm install -g phala`
- An S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, etc.)
- Docker installed locally (for building the image)
- An SSH key pair (for accessing the CVM)

## Quick start

### 1. Create an S3 bucket

**Cloudflare R2** (recommended for simplicity):

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) > R2 > **Create bucket**
2. Go to R2 > **Manage R2 API Tokens** > **Create API Token**
3. Set permissions to **Object Read & Write**, scope to your bucket
4. Save the **Access Key ID** and **Secret Access Key**

### 2. Generate a master key

The master key is the single secret that derives all encryption passwords and the gateway auth token. Keep it safe — if you lose it, your encrypted data is unrecoverable.

```sh
head -c 32 /dev/urandom | base64
```

### 3. Create your secrets file

```sh
cp phala-deploy/secrets/r2.env.example phala-deploy/secrets/r2.env
```

Edit `phala-deploy/secrets/r2.env`:

```env
MASTER_KEY=<your-base64-master-key>
S3_BUCKET=<your-bucket-name>
S3_ENDPOINT=<your-s3-endpoint-url>
S3_PROVIDER=Cloudflare
S3_REGION=auto
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
```

This file is gitignored. Never commit it.

### 4. Build and push the Docker image

```sh
# Build from repo root
docker build -f phala-deploy/Dockerfile -t your-dockerhub-user/openclaw-cvm:latest .

# Push to Docker Hub (Phala needs a registry-hosted image)
docker push your-dockerhub-user/openclaw-cvm:latest
```

### 5. Update docker-compose.yml

Edit `phala-deploy/docker-compose.yml` and set the `image:` to your pushed image:

```yaml
image: your-dockerhub-user/openclaw-cvm:latest
```

### 6. Deploy to Phala Cloud

```sh
cd phala-deploy

phala deploy \
  -n my-openclaw \
  -c docker-compose.yml \
  -t tdx.medium \
  --dev-os \
  --wait
```

The CLI will output your CVM ID and dashboard URL. Save these.

### 7. Set environment variables

Go to the [Phala Cloud dashboard](https://cloud.phala.com), open your CVM, and add the env vars from your `r2.env` file to the **encrypted environment** configuration. These are injected at runtime and never stored in plaintext.

Alternatively, pass them via the CLI:

```sh
phala deploy --cvm-id <your-cvm-uuid> \
  -e MASTER_KEY=<...> \
  -e S3_BUCKET=<...> \
  -e S3_ENDPOINT=<...> \
  -e S3_PROVIDER=Cloudflare \
  -e AWS_ACCESS_KEY_ID=<...> \
  -e AWS_SECRET_ACCESS_KEY=<...>
```

### 8. Verify

Check the CVM logs:

```sh
phala cvms logs <your-cvm-uuid>
```

You should see:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
S3 storage configured (bucket: ...), setting up rclone...
rclone mount ready at /data/openclaw
Created default config at /data/openclaw/openclaw.json (token: derived)
SSH daemon started.
Docker daemon ready.
```

## Connecting to your gateway

The gateway listens on port 18789. Your CVM exposes this via the Phala network. Find the public URL in the Phala dashboard under your CVM's port mappings.

The gateway auth token is derived from your master key, so it is stable across restarts. You can find it in the boot logs or derive it yourself:

```sh
node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', '<your-master-key>', '', 'gateway-auth-token', 32);
  console.log(Buffer.from(key).toString('base64').replace(/[/+=]/g, '').slice(0, 32));
"
```

## SSH access

SSH into the container for debugging:

```sh
# Set the SSH host (find app_id and gateway in the Phala dashboard)
export CVM_SSH_HOST=<app_id>-1022.<gateway>.phala.network

# Interactive shell
./phala-deploy/cvm-ssh

# Run a command
./phala-deploy/cvm-exec 'OPENCLAW_STATE_DIR=/data/openclaw openclaw channels status --probe'

# Copy files
./phala-deploy/cvm-scp pull /data/openclaw/.openclaw ./backup
./phala-deploy/cvm-scp push ./backup/.openclaw /data/openclaw
```

Note: SSH sessions don't have `OPENCLAW_STATE_DIR` set. Always prefix commands with `OPENCLAW_STATE_DIR=/data/openclaw`.

## Updating

To update the OpenClaw version:

1. Rebuild the Docker image (picks up latest `@h4x3rotab/openclaw` from npm)
2. Push to your registry
3. Redeploy:

```sh
phala deploy --cvm-id <your-cvm-uuid> -c docker-compose.yml
```

The new image pulls in the background. The old container keeps running until the new one is ready.

## How encryption works

```
MASTER_KEY (one secret)
  ├── HKDF("rclone-crypt-password")  → file encryption key
  ├── HKDF("rclone-crypt-salt")      → encryption salt
  └── HKDF("gateway-auth-token")     → gateway auth

/data/openclaw (FUSE mount)
  └── rclone crypt (NaCl SecretBox)
       └── S3 bucket (encrypted blobs + encrypted filenames)
```

- All files are encrypted client-side before upload
- Filenames are encrypted (S3 bucket contents are unreadable gibberish)
- S3 provider never sees plaintext
- SQLite databases are kept locally and backed up to S3 every 60 seconds

For full details, see [S3_STORAGE.md](S3_STORAGE.md).

## Disaster recovery

If your CVM is destroyed:

1. Create a new CVM with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same keys, restores data from S3, and mounts
3. Everything is restored automatically (config, agents, memory)
4. The gateway auth token is the same — existing clients reconnect without changes

Maximum data loss: 60 seconds of SQLite writes (the backup interval).

## File reference

| File | Purpose |
|------|---------|
| `Dockerfile` | CVM image (Ubuntu 24.04 + Node 22 + rclone + Docker-in-Docker) |
| `entrypoint.sh` | Boot sequence: key derivation, S3 mount, SSH, Docker, gateway |
| `docker-compose.yml` | Compose file for `phala deploy` |
| `secrets/r2.env` | Your credentials (gitignored) |
| `cvm-ssh` | Interactive SSH into the container |
| `cvm-exec` | Run a command in the container |
| `cvm-scp` | Copy files to/from the container |
| `S3_STORAGE.md` | Detailed S3 encryption documentation |

## Troubleshooting

**Mount fails ("ERROR: rclone mount not ready after 10s")**
- Check S3 credentials are correct
- Check the bucket exists
- Check `S3_PROVIDER` matches your provider (e.g. `Cloudflare` for R2)

**Gateway says "Missing config"**
- The S3 mount may not be ready. Check `mountpoint /data/openclaw` via SSH.

**"container name already in use" on redeploy**
- The old container auto-restarts before compose runs. Wait a moment and retry, or check `journalctl -u app-compose` on the VM host.

**SQLite errors**
- Memory databases are symlinked to local storage. Check `/data/openclaw-local/sqlite/` via SSH.

**Docker daemon fails inside CVM**
- This is non-critical (gateway works without it). The CVM kernel may not support all iptables modules. Check logs for details.
