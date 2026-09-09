# Execution target architecture

Porta distinguishes three concepts:

- **HTTP/UI target** (`PortaTarget`): a remote Porta API endpoint used by the web frontend.
- **Development target** (`ExecutionTarget`): a stable runtime/tool boundary where a task's workspace operations execute.
- **Deployment target** (`DevelopmentDeployment.target`): the destination of a release, currently `porta-nas`.

A `DevelopmentTask` may bind `developmentTargetId` and a workspace identity independently of its deployment target. The orchestrator remains authoritative for task state, persistence, approvals, barriers, and recovery.

`TargetRegistry` resolves a stable execution-target ID and qualifies availability/capabilities. `DevelopmentRunner` resolves the bound target before each development phase. A missing target or required capability produces `target_unavailable`; it never silently falls back to the orchestrator's local tools.

`GatewayDevelopmentPhaseDriver` uses the target-bound gateway when one is provided. This is the generic seam for a future PC target. Release ownership is split: a bound target may provide commit, push, image build, and image push capabilities; the orchestrator retains deployment and qualification through a separate `DeploymentCoordinator`. A target-bound release never falls back to the orchestrator's local release capabilities. Deployment remains a distinct target (`porta-nas`) and is persisted separately from the development target.

## Invariants

- `SELF-TARGET-001`: target and workspace identity persist with the DevelopmentTask.
- `SELF-TARGET-CAP-001`: required capabilities resolve against the assigned target, with no local fallback.
- `SELF-TARGET-APPROVAL-001`: target execution remains behind orchestrator-owned gateway/approval composition.
- `SELF-WORKSPACE-BINDING-001`: target release operations use the task-bound workspace.
- `SELF-RELEASE-SPLIT-001`: target release operations and orchestrator deployment may run on different targets.
- `SELF-ORCHESTRATOR-001`: recovery uses persisted release/deployment metadata and does not require local Git or Docker.

The existing `PortaTarget` HTTP proxy is intentionally not reused as an execution target.
