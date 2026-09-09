# Phase 3 self-redeployment gap report

## Verified before implementation

- The Docker image sets `PORTA_DATA_DIR=/data`.
- SQLite persistence defaults to `/data/porta.db` when that variable is present.
- `docker-compose.yml` bind-mounts the host `./data` directory to `/data`.
- Therefore ordinary container recreation preserves the authoritative task database, provided the NAS keeps the `data` bind mount and does not delete it.
- The current checked-in compose file does not configure an image repository, registry, or immutable image convention.

## Implemented seams

- Structured bounded development execution records are now part of persisted development state.
- Git exposes current revision, commit, and push capabilities through the existing Git provider/tool route.
- `DockerImageAdapter` builds an explicitly configured image from a workspace and pushes both an immutable tag and `latest`.
- `OneShotSshDeployment` invokes exactly `ssh deploy_porta@nas` with no remote command.
- `qualifyDeployment` checks readiness, reported revision, and task API reachability.
- Deployment and image state types retain previous/attempted identity metadata.

## Not yet qualified or fully orchestrated

- The runner does not yet coordinate Git commit, image build/push, deployment handoff, or post-replacement recovery as durable phases.
- No image repository exists in current project configuration; deployment cannot safely infer one.
- No live registry push or NAS deployment was attempted.
- The SSH account's deployment result and the new instance's persistent task recovery are not connected to the runner yet.
- Readiness/task qualification needs an authenticated task API mechanism for protected deployments.
- No safe automatic rollback primitive exists.
- A real model qualification that modifies a disposable Porta checkout has not been run.

Phase 3 is therefore **not complete**. The image and deployment adapters are capability seams and deterministic tests, not evidence of a successful self-redeployment.
