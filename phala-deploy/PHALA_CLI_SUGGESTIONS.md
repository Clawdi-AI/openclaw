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

## 2026-02-02

### Show public URLs in `phala cvms get`

`phala cvms get` doesn't show port mappings or the gateway hostname. Users have to manually construct URLs like `<app_id>-<port>.<gateway>.phala.network`. The command should display the public URL for each exposed port.

### Fix `phala cvms get --json`

JSON output returns empty strings for key fields (e.g. `hosted_on`, `dstack_node_info.endpoint`). The non-JSON table output also truncates the app URL.

### Clarify `phala cvms logs` vs `phala logs`

`phala cvms logs` returns VM serial logs (includes noisy dockerd/containerd output). `phala logs` returns clean container logs. The distinction isn't documented or obvious. Consider making `phala logs` the default and adding `phala logs --serial` for VM-level logs, or at least document the difference.

### Show image pull progress after `phala deploy --cvm-id`

After updating a compose digest, `phala deploy --cvm-id` returns immediately but the new container doesn't start for minutes while the image pulls. There's no way to track progress. A `--wait` flag (like initial deploy) or a progress indicator would help.

### Add `phala cvms restart`

No way to restart a container without redeploying the same compose file. A simple `phala cvms restart <name>` would be useful.

### Allow multiple names in `phala cvms delete`

`phala cvms delete cvm1 cvm2 cvm3 -y` would be more convenient than running the command once per CVM.
