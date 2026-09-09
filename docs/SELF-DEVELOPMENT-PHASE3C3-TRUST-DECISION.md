# Phase 3C.3 qualification trust decision

## B5 status: RESOLVED

Selected model: **Variant B — replacement-instance internal qualification**.

The replacement Porta process already owns the authoritative SQLite task store. Startup recovery now uses an internal application seam:

- loads the persisted task by session/task identity;
- reads the persisted deployment ID and expected revision;
- reads local build metadata through `buildInfo()`;
- verifies readiness by virtue of successful application startup;
- verifies task identity and expected revision without an HTTP round trip;
- never requires `PORTA_DEPLOYMENT_HEALTH_TOKEN` for self-owned recovery.

External `qualifyDeployment()` remains available for an explicitly configured external controller, but it is no longer required for replacement-instance recovery.

## Trust boundary

Public/read-only build and readiness endpoints remain separate from privileged task state. Internal recovery reads the local `TaskStore`; no anonymous task endpoint was added and no authentication boundary was weakened.

The local revision comparison accepts a full or short build revision only when one is a prefix of the other. A missing or mismatching revision fails qualification.

## Evidence

- `src/development-runner.ts`: local qualification fallback.
- `src/porta-application.ts`: startup recovery invokes the runner's internal qualification path.
- Existing runner recovery tests remain green.

No registry push or NAS deployment was performed during this trust-boundary change. The next bootstrap image must be rebuilt from the resulting clean commit before any registry mutation.
