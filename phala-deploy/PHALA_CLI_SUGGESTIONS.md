# Phala CLI Suggestions

Collected ideas for improving the Phala Cloud CLI. File issues or PRs upstream as appropriate.

## 2026-02-01

### Support `build:` in compose (or give a clear error)

Phala silently accepts compose files with `build:` but the container never starts. Either build remotely or reject upfront with: "Phala Cloud requires pre-built images. Push your image to a registry and use `image:` instead."

### Allow `--name` for updates

`phala deploy -n openclaw-dev` should update an existing CVM with that name instead of erroring. Currently you must use `--cvm-id <uuid>`. The UUID is hard to remember.

### Surface container crash logs

When a container exits immediately, `phala logs <name>` says "No containers found." It should still return logs from the exited container (like `docker logs` does).

### Add `phala exec`

Like `docker exec` — run a command inside a running container without setting up SSH tunnels.

### Improve error messages

The "Required" validation error for `phala logs` should say "Container name is required as a positional argument" instead of just `Invalid value for "containerName": Required`.
