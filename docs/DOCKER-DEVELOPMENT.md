# Docker development node

Porta includes a persistent, non-root Docker development node:

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:4173/ready
curl http://127.0.0.1:4173/identity
```

The default Compose stack contains only Porta. It does not run TPA Hub, expose
Docker's socket, or contain credentials.

## Responsibility model

- **APT during `docker build`** installs trusted system dependencies.
- **Mema local** provides the pinned Go and Rust/Cargo development toolchains.
- **TPA Hub** remains an external signed APT repository.
- **APT** is the normal consumer of published TPA Hub packages; the `tpahub`
  CLI is not required for normal consumption.
- **Git** remains the source of truth for projects in `/workspace`.
- **Porta** owns orchestration, approvals, execution, and persistent state.

## Container configuration and persistence

Compose uses `porta.docker.json`, not the host-specific `porta.json`. The
container configuration uses `/workspace` as the filesystem root and
`/data/porta.db` for SQLite persistence. The host configuration is unchanged.

Named volumes contain:

- `porta-data` → `/data`: identity, SQLite state, and other Porta state.
- `porta-workspace` → `/workspace`: repositories and development files.

The standard Mema toolchains are baked into the image under the non-root user's
local scope. They are deliberately not mounted over by a Mema volume, so an
old volume cannot hide a newer image's declared toolchain versions. Rebuild the
image after changing `GO_VERSION` or `RUST_VERSION` in `docker-compose.yml`.

The Mema download cache is used during image construction with a BuildKit cache
mount and is not runtime state. Runtime-installed extra tools, if needed, are
user-owned and are not part of the reproducible standard image.

## Mema toolchains

Mema is built from the pinned revision declared in `Dockerfile`. It is run as
UID `10001` in local mode:

```text
/home/porta/.local/share/mema
/home/porta/.local/bin
```

The image currently installs these exact recipe versions:

```text
Go   1.26.5
Rust 1.97.1
```

Check them as the running user:

```bash
docker compose exec porta sh -lc 'id; which mema; mema --help; which go; go version; which rustc; rustc --version; which cargo; cargo --version'
```

Mema runtime installation remains a user-owned operation and must continue to
use Porta's existing execution authorization and approval policy. The default
configuration does not grant arbitrary runtime APT mutation or automatically
publish packages.

Node remains supplied by the pinned `node:22.19.0-bookworm-slim` base image.
Python remains a Debian system dependency. Git is installed by APT during the
image build.

## TPA Hub and APT consumption

TPA Hub is not a service in this Compose topology. A published public TPA Hub
repository can be consumed by a dedicated consumer image or by an explicit
build configuration using its public key and standard APT source. No private
repository is configured by default.

Private consumption requires a repository **reader token**, never a publisher
token. Supply it only through an approved BuildKit secret or runtime secret
mechanism. Never put it in `Dockerfile`, `docker-compose.yml`, `porta.json`,
image layers, or Git.

The normal split is:

```text
Mema/TPA → .deb → TPA Hub → signed APT repository → apt update/install
```

The Porta runtime remains non-root; system package changes belong in an image
build. Do not use agent execution to perform arbitrary runtime `apt install`.

## Git authentication and exposure

Git and the SSH client are installed, but credentials are not included. Prefer
an explicitly scoped SSH agent or runtime secret. The default API publication
is `127.0.0.1:4173`; do not expose it directly to the public Internet.
