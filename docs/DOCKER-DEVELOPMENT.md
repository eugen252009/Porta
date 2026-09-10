# Docker development node

This repository includes a disposable Porta development node in `docker-compose.yml`.

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:4173/ready
```

Open `http://127.0.0.1:4173` in a browser. The container starts the same Web application as `npm run porta:web`; `--network` makes the listener bind to the container interface while Compose publishes it only on the host loopback interface.

## Configuration paths

Compose mounts the host `./porta.json` read-only at `/config/porta.json`, which is selected by `PORTA_CONFIG`. Paths inside that file are container paths, not paths from the host. For this environment, use at least:

```json
{
  "filesystem": {
    "root": "/workspace",
    "mutation": { "enabled": true }
  },
  "persistence": {
    "enabled": true,
    "driver": "sqlite",
    "path": "/data/porta.db"
  },
  "git": { "enabled": true },
  "execution": {
    "enabled": true,
    "allowedCommands": ["git", "node", "npm", "python3", "go", "rustc", "cargo"],
    "filesystem": "allow",
    "network": "best-effort"
  }
}
```

If `persistence` is omitted, Porta's existing `PORTA_DATA_DIR=/data` fallback enables SQLite at `/data/porta.db`. An explicitly configured persistence path takes precedence, so it must also point into `/data` if the state volume is to contain it.

The checked-in configuration may contain host-specific filesystem paths. Copy or edit it for the container rather than exposing those host paths in the image.

## Persistent storage

Two named volumes are used:

- `porta-data` → `/data`: SQLite database, node identity, WebAuthn/integration state, and other Porta state.
- `porta-workspace` → `/workspace`: repositories and development files.

`docker compose down` does not remove named volumes. To deliberately remove all state, use `docker compose down -v`.

The image creates a non-root `porta` user (UID 10001). The entrypoint fixes ownership of only the writable data and workspace volumes at startup. The configuration mount remains read-only.

## Git authentication

Git and `openssh-client` are installed, but no credentials are included in the image. Prefer an SSH agent for local use. For example, expose an agent socket to the container with a local Compose override (do not commit it):

```yaml
services:
  porta:
    environment:
      SSH_AUTH_SOCK: /ssh-agent
    volumes:
      - ${SSH_AUTH_SOCK}:/ssh-agent
```

Use a dedicated host key/configuration and confirm the agent only has the intended keys. HTTPS credentials should be provided at runtime through a credential helper or secret, never placed in `porta.json`, the Dockerfile, or the image.

The Docker setup deliberately does **not** mount `/var/run/docker.sock`; that socket grants broad control over the host Docker daemon.

## Network exposure

The default publication is `127.0.0.1:4173:4173`. To make it reachable from a trusted LAN, change it to `4173:4173` and enforce access with the host firewall or a trusted reverse proxy. Do not publish it directly to the public internet.
