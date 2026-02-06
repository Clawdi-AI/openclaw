# Deploy OpenClaw on Phala Cloud

Run an OpenClaw gateway inside a Phala Confidential VM (CVM) with optional encrypted S3-backed storage.

## Storage modes

| Mode                 | State location                            | Persistence              | Best for              |
| -------------------- | ----------------------------------------- | ------------------------ | --------------------- |
| **S3 (recommended)** | Encrypted S3 bucket via rclone FUSE mount | Survives CVM destruction | Production            |
| **Local volume**     | Docker volume inside the CVM              | Lost if CVM is destroyed | Testing / development |

S3 mode is enabled by setting `S3_BUCKET`. Without it, the CVM uses a local Docker volume.

## Prerequisites

- A [Phala Cloud](https://cloud.phala.com) account
- The [Phala CLI](https://docs.phala.network/cli) installed: `npm install -g phala`
- Docker installed locally (for building the image)
- An SSH key pair (for accessing the CVM)
- (S3 mode) An S3-compatible bucket (Cloudflare R2, AWS S3, MinIO, etc.)

## Quick start

### 1. Create an S3 bucket (skip for local-only mode)

**Cloudflare R2** (recommended for simplicity):

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) > R2 > **Create bucket**
2. Go to R2 > **Manage R2 API Tokens** > **Create API Token**
3. Set permissions to **Object Read & Write**, scope to your bucket
4. Save the **Access Key ID** and **Secret Access Key**

### 2. Generate a master key

The master key derives all encryption passwords and the gateway auth token. Keep it safe — if you lose it, your encrypted data is unrecoverable.

```sh
head -c 32 /dev/urandom | base64
```

### 3. Create your secrets file

```sh
cp phala-deploy/secrets/.env.example phala-deploy/secrets/.env
```

**S3 mode** — edit `phala-deploy/secrets/.env`:

```env
MASTER_KEY=<your-base64-master-key>
REDPILL_API_KEY=<your-redpill-api-key>
S3_BUCKET=<your-bucket-name>
S3_ENDPOINT=<your-s3-endpoint-url>
S3_PROVIDER=Cloudflare
S3_REGION=auto
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
```

**Local-only mode** — only two variables required:

```env
MASTER_KEY=<your-base64-master-key>
REDPILL_API_KEY=<your-redpill-api-key>
```

Get a Redpill API key at [redpill.ai](https://redpill.ai). This gives access to GPU TEE models (DeepSeek, Qwen, Llama, etc.) with end-to-end encrypted inference.

This file is gitignored. Never commit it.

### 4. Docker image

A pre-built image is available on Docker Hub. The `docker-compose.yml` already pins the image by digest. No build step needed unless you want a custom image.

To build your own:

```sh
pnpm build
pnpm ui:install
pnpm ui:build
npm pack
mv openclaw-<version>.tgz phala-deploy/openclaw.tgz
docker build -f phala-deploy/Dockerfile -t your-dockerhub-user/openclaw-cvm:latest .
docker push your-dockerhub-user/openclaw-cvm:latest
# Then update the image: line in docker-compose.yml
```

### 5. Deploy to Phala Cloud

```sh
cd phala-deploy

phala deploy \
  -n my-openclaw \
  -c docker-compose.yml \
  -e secrets/.env \
  -t tdx.medium \
  --dev-os \
  --wait
```

The `-e secrets/.env` flag passes your secrets as encrypted environment variables. They are injected at runtime and never stored in plaintext.

The CLI will output your CVM ID and dashboard URL. Save these.

### 6. Verify

Check the container logs:

```sh
phala logs openclaw --cvm-id <your-cvm-name-or-uuid>
```

**S3 mode** — you should see:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
S3 storage configured (bucket: ...), setting up rclone...
Attempting FUSE mount...
rclone FUSE mount ready at /data
Home symlinks created (~/.openclaw, ~/.config → /data)
SSH daemon started.
Docker daemon ready.
```

**Local-only mode** — you should see:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
Home symlinks created (~/.openclaw, ~/.config → /data)
SSH daemon started.
Docker daemon ready.
```

### 7. What's next

1. **Open the dashboard** — go to `https://<app_id>-18789.<gateway>.phala.network?token=<your-gateway-token>` (see [Connecting to your gateway](#connecting-to-your-gateway) for how to construct this URL)

2. **Create your agent** — send `wake up` in the dashboard chat. The agent will walk you through creating a persona (name, personality, instructions).

3. **Connect Telegram** — once your agent is set up, send a message in the dashboard chat asking it to connect to your Telegram bot. Provide your Telegram bot token (from [@BotFather](https://t.me/BotFather)) and the agent will set up the connection and pair itself with the bot.

After that, your agent is live on Telegram and you can chat with it there.

## How S3 storage works

The entrypoint tries two S3 sync strategies in order:

### FUSE mount (preferred)

If `/dev/fuse` is available, rclone mounts the encrypted S3 bucket directly at `/data/openclaw` as a FUSE filesystem. The VFS cache layer handles syncing automatically:

- Writes are cached locally and flushed to S3 after 5 seconds idle
- Reads go through the local cache
- No background sync jobs needed — rclone handles everything
- SQLite (memory.db) works directly on the mount via the VFS write cache

```
/data/openclaw  (FUSE mount)
  └── rclone crypt (NaCl SecretBox)
       └── S3 bucket (encrypted blobs + encrypted filenames)
```

### Sync fallback

If FUSE is unavailable, the entrypoint falls back to periodic `rclone copy`:

- On boot: pulls all state from S3 to the local Docker volume
- Every 60 seconds: pushes changes back to S3
- SQLite files are kept in a separate local directory and synced independently
- Symlinks redirect `memory.db` from the state dir to local storage

Maximum data loss in sync mode: 60 seconds of writes.

## How encryption works

```
MASTER_KEY (one secret)
  ├── HKDF("rclone-crypt-password")  → file encryption key
  ├── HKDF("rclone-crypt-salt")      → encryption salt
  └── HKDF("gateway-auth-token")     → gateway auth
```

- All files are encrypted client-side before upload (NaCl SecretBox)
- Filenames are encrypted (S3 bucket contents are unreadable)
- S3 provider never sees plaintext

For full details, see [S3_STORAGE.md](S3_STORAGE.md).

## Connecting to your gateway

The gateway listens on port 18789. The CVM exposes it via the Phala network at:

```
https://<app_id>-18789.<gateway>.phala.network
```

Find your `app_id` and `gateway` in the Phala dashboard under your CVM's details, or from the deploy output.

To open the dashboard with authentication, append your gateway token to the URL:

```
https://<app_id>-18789.<gateway>.phala.network?token=<your-gateway-token>
```

The gateway auth token is derived from your master key, so it is stable across restarts. You can derive it locally:

```sh
node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', '<your-master-key>', '', 'gateway-auth-token', 32);
  console.log(Buffer.from(key).toString('base64').replace(/[/+=]/g, '').slice(0, 32));
"
```

## SSH access

The container runs an SSH daemon on port 1022. The CVM exposes it via the Phala network.

### Setup

Set the SSH host (find `app_id` and `gateway` from the Phala dashboard):

```sh
export CVM_SSH_HOST=<app_id>-1022.<gateway>.phala.network
```

Your SSH public key is automatically injected into the container from the CVM host.

### Usage

```sh
# Interactive shell
./phala-deploy/cvm-ssh

# Run a command
./phala-deploy/cvm-exec 'openclaw channels status --probe'

# Copy files to/from the container
./phala-deploy/cvm-scp pull /root/.openclaw ./backup
./phala-deploy/cvm-scp push ./backup /root/.openclaw
```

**Note:** The entrypoint creates symlinks `~/.openclaw → /data/openclaw` and `~/.config → /data/.config`, so `openclaw` commands work without any env var prefixes.

### Restart policy

The entrypoint keeps SSH available even if the gateway crashes and restarts it with backoff.

- `OPENCLAW_GATEWAY_RESTART_DELAY` sets the initial backoff in seconds (default `5`).
- `OPENCLAW_GATEWAY_RESTART_MAX_DELAY` caps backoff in seconds (default `60`).
- `OPENCLAW_GATEWAY_RESET_AFTER` resets backoff after a stable run (seconds, default `600`).

## Updating

To update the OpenClaw version:

1. Build a tarball and place it at `phala-deploy/openclaw.tgz`:

```sh
pnpm build
pnpm ui:install
pnpm ui:build
npm pack
mv openclaw-<version>.tgz phala-deploy/openclaw.tgz
```

2. Rebuild the Docker image
3. Push to your registry
4. Redeploy:

```sh
phala deploy --cvm-id <your-cvm-uuid> -c docker-compose.yml
```

The new image pulls in the background. The old container keeps running until the new one is ready.

**Verification notes:**

- `phala deploy` is the reliable rollout path. `phala cvms logs` can lag, so confirm with a live version check via `cvm-exec` (for example: `./phala-deploy/cvm-exec 'openclaw --version'`).
- `rv-exec` with `CVM_SSH_HOST` is sufficient to verify the live container without exposing secrets.

## Disaster recovery

If your CVM is destroyed (S3 mode only):

1. Create a new CVM with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same keys, mounts S3, and everything is restored
3. Config, agents, and memory are all recovered automatically
4. The gateway auth token is the same — existing clients reconnect without changes

## File reference

| File                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `Dockerfile`         | CVM image (Ubuntu 24.04 + Node 22 + rclone + Docker-in-Docker) |
| `entrypoint.sh`      | Boot sequence: key derivation, S3 mount, SSH, Docker, gateway  |
| `docker-compose.yml` | Compose file for `phala deploy`                                |
| `secrets/.env`       | Your credentials (gitignored)                                  |
| `cvm-ssh`            | Interactive SSH into the container                             |
| `cvm-exec`           | Run a command in the container                                 |
| `cvm-scp`            | Copy files to/from the container                               |
| `S3_STORAGE.md`      | Detailed S3 encryption documentation                           |

## Troubleshooting

**FUSE mount falls back to sync mode**

- This is expected if `/dev/fuse` is not available. Sync mode works but has up to 60s data loss on destruction.
- Check logs for "FUSE mount failed, falling back to sync mode."

**Gateway says "Missing config"**

- The S3 mount may not be ready. Check `mount | grep fuse.rclone` via SSH.

**"container name already in use" on redeploy**

- The old container auto-restarts before compose runs. Wait a moment and retry, or check `journalctl -u app-compose` on the VM host.

**Docker daemon fails inside CVM**

- This is non-critical (gateway works without it). The CVM kernel may not support all iptables modules. Check logs for details.
