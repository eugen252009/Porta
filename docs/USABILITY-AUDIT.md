# Porta usability audit: using Porta to update Porta

**Scope:** current checkout, local web/TUI workflow, and the Docker deployment.  
**Audience:** an operator who wants Porta to inspect, modify, verify, and redeploy this repository.

## Executive summary

Porta is usable for assisted development today, but it is not yet a complete self-update/deployment system. The local coding workflow is mostly present: model selection, confined filesystem access, approval prompts, task/evidence tracking, Git inspection, command execution, artifacts, and diagnostics. The deployment workflow stops at the SSH boundary.

The command `ssh deploy_porta@nas` proves that an SSH login may be available, but it is not by itself a deployment action. Porta also needs a configured workspace, a model, write/command permissions, SSH client credentials, the remote checkout path, and an explicit safe remote command.

## What is needed

### Minimum runtime

Choose one of these model setups:

- **Codex subscription:** Node.js 22.19+, `porta login openai-codex`, and a model available to the account.
- **Local/OpenAI-compatible model:** a reachable `/v1` server and its model name.
- **Docker:** use the supplied image; the model endpoint must be reachable from inside the container.

For a checkout-based workflow, install dependencies and run the diagnostics first:

```bash
npm install
npm run build
npm link
porta doctor --verbose
```

### Workspace and permissions

The active workspace must be the Porta repository. The configuration must explicitly enable:

- `filesystem.root` pointing at the repository;
- `filesystem.mutation.enabled: true` for edits;
- `authorization.mode: "require-approval"` (recommended);
- `execution.enabled: true` with a narrow command allowlist for tests/builds;
- `git.enabled: true` for status/diff/log/show inspection;
- SQLite persistence if the session must survive a restart.

The current checked-in `porta.json` is suitable for the host checkout only. It points at `/home/eugen/projekte/Porta/`, which is not the same path inside the Docker image.

A safe first task should be read-only: ask Porta to inspect the repository, explain the intended change, and create a verification plan. Enable mutation only after reviewing that plan.

### Deployment access

To update the running NAS deployment, all of the following must be true:

1. The repository changes are committed and available to the NAS (for example, pushed to the expected Git remote).
2. The NAS checkout path and compose project name are known.
3. The `deploy_porta` account can log in non-interactively using an SSH key.
4. The execution environment has an SSH client and access to that key. The current Docker image does **not** install an SSH client or mount an SSH key.
5. The remote account can run Docker Compose without an interactive password prompt.
6. The remote deployment command is explicitly allowlisted and approval-gated.

Porta's Git capability intentionally does not commit, push, or perform remote Git operations. Command execution and SSH therefore need to be supplied as a separately authorized deployment capability; they should not be enabled with a broad shell allowlist.

## Recommended self-update flow

1. **Inspect:** `git status`, relevant files, Docker configuration, and current tests.
2. **Plan:** record the objective, changed files, verification criteria, and rollback plan in a Porta task.
3. **Edit:** approve only the requested filesystem mutations.
4. **Verify locally:** run the narrow tests first, then:

   ```bash
   npm test
   npm run typecheck
   npm run build
   docker compose config
   ```

5. **Review:** inspect `git diff`, confirm no secrets or generated files are included, and commit the change outside Porta if appropriate.
6. **Deploy:** run the approved remote command below with the actual checkout path substituted.
7. **Verify remotely:** check container status, logs, and the HTTP endpoint. Record the result as task evidence.
8. **Rollback:** retain the previous commit/image and define the exact rollback command before deployment.

## NAS redeploy command

The current `docker-compose.yml` uses `build: .`, not a registry `image:`. Therefore the normal command rebuilds on the NAS; `docker compose pull` alone will not deploy the latest source:

```bash
ssh deploy_porta@nas \
  'cd /path/to/Porta && git pull --ff-only && docker compose up -d --build --force-recreate && docker compose ps'
```

Replace `/path/to/Porta` with the real NAS checkout path. If the NAS receives a prebuilt image instead, use the registry-specific `docker compose pull && docker compose up -d` workflow and document the image tag. Do not silently use `latest` for production updates.

A useful post-deploy check is:

```bash
curl --fail http://nas:4173/
ssh deploy_porta@nas 'cd /path/to/Porta && docker compose logs --tail=100 porta'
```

## Important Docker usability gaps

- The compose file has no healthcheck, image tag, or documented persistent backup/restore procedure.
- The config and data directories are bind mounts, but their host paths and permissions are not documented for the NAS operator.
- The container entrypoint changes ownership recursively on `/config`, `/data`, and `/workspaces`; this can be surprising for shared mounts.
- A workspace mount is commented out. Without one, the web instance cannot edit the Porta source tree.
- The container has no SSH client/key setup, so it cannot perform the proposed NAS-to-NAS deployment itself.
- `PORTA_CONFIG=/config/porta.json` requires a NAS-specific config. Host paths from the checked-in config must not be reused unchanged in the container.
- `docker compose up -d --build` builds from whatever source is present on the NAS. The operator needs a pinned commit check before building to avoid deploying an unintended working tree.

## Priority recommendations

### P0 — required before unattended self-deployment

- Add a documented NAS checkout path and one reviewed deploy script using `git pull --ff-only`, a pinned commit check, build, restart, health check, and failure output.
- Keep deployment approval mandatory; never add unrestricted `sh`, `ssh`, or `docker` to the default allowlist.
- Add a rollback procedure and verify that `/data` is backed up.
- Provide a container-specific config example with `/workspaces/Porta` and an explicit workspace mount.

### P1 — strongly improves usability

- Add a Docker `healthcheck` and expose a version/commit endpoint already reported by `doctor`.
- Make the compose deployment use an immutable image tag or commit label rather than an implicit latest build.
- Add a `deploy:check` or equivalent deterministic script that validates Node/model/config/workspace/SSH prerequisites without changing anything.
- Show deployment prerequisites and the exact approved command in the web UI before execution.

### P2 — convenience

- Add a dedicated deployment adapter instead of treating SSH as generic shell execution.
- Add a dry-run mode that reports files, tests, commit, remote target, and expected restart impact.
- Add an operator-facing runbook for logs, backup restore, and rollback.

## Usability verdict

**Local assisted maintenance:** usable with explicit configuration and approvals.  
**Container operation:** usable after a NAS-specific config and workspace mount are supplied.  
**Porta updating Porta and redeploying itself:** not currently turnkey; it requires a controlled deployment capability, remote path/credentials, a pinned deployment command, health checks, and rollback handling.
