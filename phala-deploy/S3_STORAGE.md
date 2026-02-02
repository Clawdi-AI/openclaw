# Encrypted S3 Storage for CVM

The CVM can use S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, etc.) as its state backend. All data is encrypted client-side before upload using rclone's crypt overlay, so the storage provider never sees plaintext.

## Architecture

```
/data/openclaw  (FUSE mount — apps read/write normally)
  └── rclone crypt  (NaCl SecretBox encryption)
       └── S3 remote  (any S3-compatible provider)
```

The gateway and all tools interact with `/data/openclaw` as a normal directory. rclone transparently encrypts filenames and file contents before uploading to S3.

## Key management

A single `MASTER_KEY` derives all cryptographic secrets via HKDF-SHA256:

```
MASTER_KEY (one secret to back up)
  ├── HKDF(info="rclone-crypt-password")  → rclone encryption password
  ├── HKDF(info="rclone-crypt-salt")      → rclone encryption salt
  └── HKDF(info="gateway-auth-token")     → gateway auth token
```

This means:
- **One secret** to manage, back up, and rotate
- Keys are deterministic — same `MASTER_KEY` always produces the same derived keys
- The gateway auth token is stable across container restarts (not random each boot)
- S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are provider-issued and stay separate

You can also set `RCLONE_CRYPT_PASSWORD` directly (without `MASTER_KEY`) for manual control.

## How it works

1. **Derive keys**: if `MASTER_KEY` is set, derive crypt passwords and gateway token via HKDF
2. **Restore**: SQLite database files are pulled from S3 to local storage
3. **Mount**: rclone mounts the encrypted S3 bucket at `/data/openclaw` via FUSE
4. **Bootstrap**: if no config exists, create one with the derived gateway token
5. **Run**: the gateway starts and reads/writes the state dir normally
6. **Backup**: a background loop copies SQLite files to S3 every 60 seconds
7. **Symlinks**: a periodic job redirects `memory.db` files to local storage (safety measure for SQLite on FUSE)

Without `S3_BUCKET` set, the entrypoint skips all S3 logic and uses the local Docker volume as before.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MASTER_KEY` | Recommended | — | Master secret. Derives crypt passwords + gateway token. |
| `S3_BUCKET` | Yes (for S3) | — | Bucket name. Presence enables S3 mode. |
| `S3_ENDPOINT` | Yes (for S3) | — | S3 endpoint URL |
| `AWS_ACCESS_KEY_ID` | Yes (for S3) | — | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | Yes (for S3) | — | S3 secret key |
| `S3_PROVIDER` | No | `Other` | rclone provider hint (`Cloudflare`, `AWS`, `Minio`) |
| `S3_PREFIX` | No | `openclaw-state` | Key prefix inside the bucket |
| `S3_REGION` | No | `us-east-1` | S3 region |
| `RCLONE_CRYPT_PASSWORD` | No | derived | Override derived crypt password (must be rclone-obscured) |
| `RCLONE_CRYPT_PASSWORD2` | No | derived | Override derived crypt salt (must be rclone-obscured) |

## Setup

### 1. Create an S3 bucket

For Cloudflare R2:
- Dashboard > R2 > Create bucket
- Create an API token with **Object Read & Write** scoped to the bucket

### 2. Generate a master key

```sh
head -c 32 /dev/urandom | base64
```

Save this value securely. If you lose it, the encrypted data on S3 is unrecoverable.

### 3. Create a secrets file

Save credentials to `phala-deploy/secrets/r2.env` (gitignored):

```env
MASTER_KEY=your-base64-master-key
S3_BUCKET=your-bucket
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_PROVIDER=Cloudflare
S3_REGION=auto
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

### 4. Deploy

For local testing:

```sh
docker build -f phala-deploy/Dockerfile -t openclaw-cvm:test .
docker run -d --name openclaw --privileged \
  --env-file phala-deploy/secrets/r2.env \
  -e OPENCLAW_STATE_DIR=/data/openclaw \
  -e NODE_ENV=production \
  -p 18789:18789 \
  openclaw-cvm:test
```

For Phala Cloud, pass the env vars through the encrypted environment configuration (never put secrets in `docker-compose.yml`).

## Verification

Check the boot log for key derivation and mount:

```
Deriving keys from MASTER_KEY...
Keys derived (crypt password, crypt salt, gateway token).
S3 storage configured (bucket: h4xtest), setting up rclone...
rclone mount ready at /data/openclaw
Created default config at /data/openclaw/openclaw.json (token: derived)
```

Check mount status:

```sh
# Inside the container
mountpoint /data/openclaw        # should say "is a mountpoint"
ls /data/openclaw/                # should show openclaw.json, agents/, etc.
```

Check that S3 contents are encrypted:

```sh
rclone ls s3:your-bucket/openclaw-state/
# Filenames should be encrypted gibberish like "kh1v5oec8hqh01519qhuit8nc8"
```

## SQLite handling

SQLite databases use file locking that can be unreliable on FUSE mounts. As a safety measure:

- `memory.db` files are kept on local storage (`/data/openclaw-local/sqlite/`)
- Symlinks in the agent directories point to the local copies
- A background job copies local SQLite files to S3 every 60 seconds
- On boot, SQLite files are restored from S3 before the mount is created

This means memory data survives container restarts (restored from S3) with at most 60 seconds of data loss.

## VFS cache settings

| Flag | Value | Effect |
|------|-------|--------|
| `--vfs-cache-mode` | `writes` | Cache writes locally, read through to S3 |
| `--vfs-write-back` | `5s` | Flush writes to S3 after 5s idle |
| `--dir-cache-time` | `30s` | Cache directory listings for 30s |
| `--vfs-cache-max-size` | `500M` | Limit local cache to 500MB |

## Disaster recovery

If the container is destroyed:

1. Create a new container with the same `MASTER_KEY` and S3 credentials
2. The entrypoint derives the same encryption keys, restores SQLite from S3, and mounts
3. All config, agent data, and memory is restored automatically
4. The gateway auth token is the same (derived, not random)

The only data at risk is SQLite writes from the last 60 seconds before destruction.

## Encryption details

rclone crypt uses:
- **NaCl SecretBox** (XSalsa20 + Poly1305) for file contents
- **EME** (ECB-Mix-ECB) wide-block encryption for filenames
- Standard filename encryption with encrypted directory names

Key derivation uses **HKDF-SHA256** (Node.js `crypto.hkdfSync`) with empty salt and purpose-specific info strings. Derived keys are 32 bytes, base64-encoded, then passed through `rclone obscure` for the crypt config.

The S3 provider sees only encrypted blobs with encrypted paths. Without the master key, the data is unrecoverable.
