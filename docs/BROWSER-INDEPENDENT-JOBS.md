# Browser-independent jobs

## Supported local workflow

1. Prepare a prompt in the official ChatGPT website.
2. Click the squirrel and select the local Porta node.
3. Wait for **Accepted by Porta · saved**. The receipt contains a job ID and an **Open Porta** link.
4. Close the ChatGPT tab or the entire browser.
5. Porta's server-owned worker executes the job. Open Porta later to read its prompt, activity, command results, final response, or failure.

No model credentials or execution capabilities move into the extension. Its existing integration credential remains limited to prompt submission and node/model discovery. WebAuthn continues to protect the human status UI independently.

This is a single-process, single-node worker with a FIFO queue. Only one submitted job executes at a time. A job waiting for approval holds that worker until the approval is resolved, the job is cancelled, or its deadline expires. Additional accepted jobs remain queued. Web composer messages use the same local submission service; remote sessions retain their existing transport behavior.

## Durable acceptance and status

With SQLite enabled, the prompt, selected model (when available), workspace, budget, authorized tool names, idempotency receipt, and queued status are inserted before acceptance. The extension's normal submission key is stable across page reloads for the same endpoint, conversation, target, model selection, and prompt. **New session** deliberately starts fresh work. An acceptance retry returns the original job, including when that job has failed; it is not an instruction to retry execution.

The original prompt is retained up to 512 KiB. The observational activity preview is bounded to 256 entries / 256,000 characters, with individual entries bounded to 32,000 characters. Truncation is explicitly indicated. Up to 64 command result previews are retained, each bounded to 4,000 characters. Existing execution artifacts retain large command output separately; successful canonical conversation turns are still committed through the normal gateway. Activity previews do not replace canonical conversation or tool artifacts.

Statuses are `queued`, `running`, `needs_attention`, `completed`, `failed`, `cancelled`, and `interrupted`. They come from the worker, not from empty/nonempty conversation history. The session view follows active work before queued or terminal work; its Run selector exposes the most recent 20 job summaries and allows earlier runs in that list to be inspected.

**Completed means the agent execution finished and its conversation commit succeeded. It does not certify that every natural-language requirement was met.** `verification: checks_recorded` means command exit codes and result summaries were observed, not that all checks passed or were sufficient. Failed iterations remain visible. Inspect the final report and recorded checks before treating a deliverable as qualified. The worker does not invent verification evidence.

Model failures, gateway exceptions, missing completion results, and exhausted step/tool budgets are persisted as failures. There is no unlimited autonomous continuation beyond the configured budget.

## Explicit unattended authorization

Safe defaults are unchanged: normal tools still require approval. `jobs.unattendedTools` is an opt-in list of **canonical tool IDs** that may run without repeated approvals, only during a queued job's execution. Tools not on that list retain the existing authorization policy. Configured providers, command allowlists, filesystem mutation enablement, and sandbox enforcement are not bypassed. On restart, queued jobs use the intersection of their accepted tool scope and the current configuration.

For automatic ordinary-file access with protected files and commands still approval-gated, prefer [`authorization.mode: "workspace"`](WORKSPACE-PERMISSIONS.md). Workspace mode takes precedence over the job allowlist described here.

Unattended scope requires SQLite persistence. Example:

```json
{
  "agent": { "maxSteps": 64, "maxToolCalls": 256 },
  "jobs": {
    "timeoutMs": 1800000,
    "maxQueued": 32,
    "unattendedTools": ["filesystem/read_file", "filesystem/write_file", "execution/run"]
  }
}
```

Merge these settings into a complete configuration; they do not independently enable filesystem access or execution. The job deadline includes model calls and approval waits. Existing per-model and per-command limits also apply.

`porta.docker.jobs.json` is a complete **opt-in development-node example**, not an automatically activated replacement for the running configuration. It preauthorizes local coding tools and uses a larger finite agent budget. Review the full list and model selection before using it.

**Security boundary:** granting `execution/run` permits the configured executables and their arguments. Interpreters, npm, and Git can perform broad actions with the container user's authority. A workspace-bound cwd and a command-name allowlist are not hard filesystem or network isolation. Host-process enforcement remains best-effort; do not assume that unattended code cannot access other files readable by that user. The example does not restrict Git to commits only or prohibit network operations through allowed programs. Use it only for trusted tasks on an appropriately isolated development node. This change does not provide per-command argument policy or a stronger sandbox.

## Lifecycle and restart

- Closing an HTTP response, SSE connection, tab, or browser does not cancel accepted work.
- Cancelling a session cancels its queued jobs and signals its active execution.
- Deleting a session with outstanding jobs is rejected.
- Application shutdown stops the worker before closing persistence.
- After a process restart, queued work can start automatically.
- Previously running or approval-waiting jobs become **interrupted**. They are not automatically replayed. Their old approval records cannot restart them through approval recovery.
- If the configured workspace or step/tool budget changed, queued work fails explicitly rather than silently running under a different workspace/budget.
- Do not run multiple Porta application processes against the same job database. Distributed worker coordination is not provided.

Plan deployments around active work. Persistent records do not make arbitrary command replay safe. The existing interrupted Snake task is not migrated, resubmitted, or automatically resumed by this implementation.

## API compatibility

`POST /api/prompt/submit` retains the session-mode request shape. Local responses add `jobId` and `durable` to the existing HTTP 202 receipt. In-memory configurations remain supported for tests/local use but return `durable: false`; their receipts do not survive restart. Task-mode submission remains unsupported, and this path does not automatically invoke the self-deployment-oriented DevelopmentRunner.

Local `POST /api/sessions/:id/messages` returns a receipt when the application has the job service; legacy gateway-only servers retain their streaming response. Clients must handle the JSON acceptance response rather than treating it as an array of model events.

Authenticated `GET /api/sessions/:id` includes the authoritative job status, bounded activity, observed checks, and recent job summaries. `?job=<id>` selects a historical job and verifies that it belongs to that session. Existing integration credentials do not gain session-reading permission. Federation/remote prompt submission is not upgraded to durable jobs in this milestone; the extension does not display the local durable guarantee for those receipts.

## Qualification

Run:

```bash
npx vitest run tests/jobs.test.ts tests/jobs-e2e.test.ts tests/extension-handoff.test.ts tests/web-ui-behavior.test.ts
npm test
npm run typecheck
npm run build
```

The deterministic E2E submits using a scoped integration credential through the real Web API, closes the Web listener, performs a real filesystem write and Node command through Porta's agent/tool gateway, restarts the application, reads the persisted result through the authenticated session API, and retries the receipt without repeating execution. It uses a scripted model, temporary directories, and local tools, not network models or production credentials.

This proves the software path, not a real ChatGPT DOM interaction or live-model coding success. A separate manual qualification should use the installed extension and an explicitly chosen small task after deployment. Do not use a production task as an implicit restart test.
