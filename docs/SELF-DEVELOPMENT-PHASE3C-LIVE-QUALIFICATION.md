# Phase 3C live qualification record

**Status: BLOCKED — not live-qualified.**

## Preflight evidence

| Check | Result |
|---|---|
| Current branch | `main` |
| Local HEAD | `b0dbf14c15b216517bbfc722f1136253d31c80e9` |
| Workspace | Dirty with tracked and untracked changes |
| Git remote | None configured (`git remote -v` returned no entries) |
| Registry | Reachable; `192.168.188.2:9006/porta:latest` is inspectable |
| Resolved image repository | `192.168.188.2:9006/porta` |
| Local latest image ID | `f98281ea41b4` |
| Registry latest digest | `sha256:f98281ea41b4cfc095181065f487467c8fe7c90c165b9aebbed91c108fa22cbf` |
| Running NAS `/version` | `0.1.0`, commit `b0dbf14c15b2`, dirty `true` |
| Running NAS readiness | `/ready` returned 404; current deployed image predates readiness endpoint |
| NAS SSH | Failed: `Permission denied (publickey,password)` |
| SSH identity selected | `~/.ssh/id_ed25519` |
| Local bind-mount recreation test | Passed in a disposable Docker container |

## Barrier state update after Phase 3C.1 preflight

- `BARRIER-LIVE-001`: **resolving** — `~/.ssh/porta_deploy` exists with restrictive permissions and the `nas` host entry now prefers it. No connection test was performed because successful `ssh deploy_porta@nas` is the deployment operation.
- `BARRIER-LIVE-002`: **resolving** — local `origin` was restored from the existing `branch.main.remote`/`branch.main.merge` configuration; `git ls-remote` and a read-only fetch succeeded. Remote `main` is an ancestor of local `main`, so the local branch is ahead, but no push was performed because the workspace is dirty.
- `BARRIER-LIVE-003`: **open** — current NAS still returns 404 for `/ready`; bootstrap deployment is required.
- `BARRIER-LIVE-004`: **open** — current running image remains dirty and the working tree remains dirty.
- `BARRIER-LIVE-005`: **open** — no health endpoint/token configuration exists.

## Barriers

### BARRIER-LIVE-001 — SSH deployment authorization unavailable

- **Classification:** configuration gap / operational blocker
- **Severity:** HIGH
- **Evidence:** `ssh -o BatchMode=yes -o ConnectTimeout=5 deploy_porta@nas true` exited 255 with `Permission denied (publickey,password)`.
- **Impact:** the required one-shot deployment cannot be safely invoked or qualified.
- **Required action:** provision/authorize the intended deployment key for `deploy_porta@nas`, without placing credentials in source, task state, logs, or the image.

### BARRIER-LIVE-002 — No Git remote or push authentication

- **Classification:** configuration gap
- **Severity:** HIGH
- **Evidence:** `git remote -v` returned no remotes.
- **Impact:** the commit/push identity chain cannot be qualified.
- **Required action:** configure the intended remote and non-interactive push authorization.

### BARRIER-LIVE-003 — Running deployment has no readiness endpoint

- **Classification:** version/deployment mismatch
- **Severity:** HIGH
- **Evidence:** `http://192.168.188.2:4173/version` responds, but `/ready`, `/health`, and `/healthz` return 404.
- **Impact:** post-deployment readiness and replacement qualification cannot be performed against the current instance.
- **Required action:** deploy a build containing `/ready`, then verify it before attempting self-redeployment.

### BARRIER-LIVE-004 — Current running revision is dirty

- **Classification:** release integrity concern
- **Severity:** HIGH
- **Evidence:** running `/version` reports commit `b0dbf14c15b2` and `dirty: true`; local workspace is also dirty.
- **Impact:** this cannot be accepted as a clean previous known-good release baseline.
- **Required action:** establish a clean committed baseline and record its image digest before qualification.

### BARRIER-LIVE-005 — Health authentication/task verification not configured

- **Classification:** configuration gap / security boundary
- **Severity:** HIGH
- **Evidence:** `PORTA_DEPLOYMENT_HEALTH_ENDPOINT` and `PORTA_DEPLOYMENT_HEALTH_TOKEN` are not set in the current environment.
- **Impact:** authenticated post-deployment task verification cannot be performed.
- **Required action:** configure an existing trusted authentication mechanism or provide a dedicated protected qualification credential. Do not weaken web authentication.

## Persistence evidence

The repository configuration shows `PORTA_DATA_DIR=/data` in the image and `./data:/data` in Compose. A disposable local Docker bind-mount recreation test also passed. This proves the local bind-mount mechanism, but not yet the actual NAS container replacement path; that remains unqualified until SSH access is restored.

## Qualification decision

No Git push, registry push, SSH deployment, production mutation, or replacement qualification was executed. The live sequence must stop before destructive operations until BARRIER-LIVE-001 through BARRIER-LIVE-005 are resolved.
