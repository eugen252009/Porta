# Phase 3C.2 bootstrap baseline record

**Status: BLOCKED before registry mutation/deployment.**

## Source baseline

- Branch: `main`
- Commit: `1eda3da`
- Commit message: `Establish controlled self-development baseline`
- Workspace: clean (`git status --porcelain` empty; `.porta/` is ignored local runtime state)
- Remote: `origin git@github.com:eugen252009/Porta.git`
- Remote `main`: `1eda3da`
- Push: successful

Changed-work classification:

- Phase implementation, tests, Docker packaging, web/authentication work, and documentation: category A, preserved and committed.
- `.porta/`: category B local runtime identity/state; ignored, not committed.
- No category C or D files were identified.

## Clean image candidate

Built locally from the clean commit:

```text
repository: 192.168.188.2:9006/porta
immutable tag: 1eda3da
local image digest: sha256:61f8f1cad558abbeb7f74951cf3205d82d1dfbfe5c6e1c6bb85e6883818e00d8
PORTA_GIT_COMMIT: 1eda3da
PORTA_BUILD_DIRTY: false
PORTA_BUILD_ID: 1eda3da
```

The image contains the `/ready` endpoint and Docker healthcheck. It has **not** been pushed to the registry.

## Barrier states

- **B1 SSH:** configured, not operationally proven. `nas` now prefers `~/.ssh/porta_deploy`; no deployment SSH invocation was attempted.
- **B2 Git:** resolved. Remote configured, read-only remote access passed, baseline commit pushed, remote SHA verified.
- **B3 `/ready`:** open. Current NAS returns 404; bootstrap deployment still required.
- **B4 dirty provenance:** resolved for the new candidate. Clean commit and image report `dirty=false`. Current production remains the old dirty image until bootstrap.
- **B5 qualification auth:** open. No `PORTA_DEPLOYMENT_HEALTH_ENDPOINT` or `PORTA_DEPLOYMENT_HEALTH_TOKEN` is configured.

## Stop decision

The bootstrap gate is not satisfied because B1 is not operationally proven, B3 still requires deployment, and B5 authentication is absent. The image was not pushed, `latest` was not changed, no persistence marker was created on NAS, and `ssh deploy_porta@nas` was not executed.

No self-development or self-redeployment qualification was started.
