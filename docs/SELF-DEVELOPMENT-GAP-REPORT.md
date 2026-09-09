# Porta self-development gap report

## Existing primitives

- `AgentExecution` and `InteractiveApprovalGateway` provide model/tool orchestration and approval-gated execution.
- `TaskStore` provides versioned, persistent session tasks with steps, criteria, immutable evidence, and completion guards.
- `PendingApprovalProvider` and web approval routes provide interactive approval handling.
- `attentionFor` already maps task/connection/waiting states to web-visible attention.
- `CliGitBackend` provides bounded read-only status, diff, show, and log.
- `ExecutionToolProvider` runs allowlisted commands with bounded output and artifact storage.
- SQLite persists sessions, conversation, task state, scratchpad, delegation, and artifacts.
- The web UI lists tasks/sessions and exposes global pending approvals.
- Docker packaging and `/version` exist; the Docker compose deployment currently builds locally and has no healthcheck.

## Missing capabilities

1. **Development task state:** no authoritative task model for development phases, permissions, plan, changed files, verification runs, deployment metadata, or attention details.
2. **Background workflow runner:** model executions are session-driven; there is no durable workflow coordinator that advances a development task independently of an HTTP request/browser tab.
3. **Intervention/resume:** approvals are process-local and pending user input has no persisted task action/resume record.
4. **Git mutation:** commit and push are intentionally absent. Dirty baseline attribution and exact commit SHA are not represented in task state.
5. **Verification records:** command results are available as execution output/artifacts, but not as structured per-stage development evidence.
6. **Image lifecycle:** no generic Docker build/tag/push capability or configuration discovery for the registry `192.168.188.2:9006`.
7. **Deployment capability:** no dedicated one-shot deployment adapter for exactly `ssh deploy_porta@nas`; generic SSH is not installed/configured in the image and must not be treated as unrestricted shell.
8. **Readiness:** `/version` proves the process responds, but there is no explicit readiness contract covering the task API and configured provider.
9. **Rollback:** previous/attempted deployment metadata is not stored and no rollback capability exists.
10. **Proposal seam:** no reviewable observation-to-development-task proposal model.
11. **Dogfood qualification:** the existing E2E validates coding tools locally, not the full image/push/deploy/health path.

## Smallest coherent implementation phase

First add the generic, persisted development-task state and web intervention surface without granting new authority:

- stable development phases and attention details;
- goal, acceptance criteria, workspace, permission intent, verification plan, deployment target;
- bounded structured verification records and revision/image metadata;
- optimistic versioned updates and persistence/restart tests;
- global web task visibility and intervention responses;
- readiness endpoint and Docker healthcheck.

Then add separately authorized adapters for Git mutation, image build/push, one-shot deployment, and health qualification. Keep live NAS qualification opt-in and never claim the complete loop until it has run successfully.
