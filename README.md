# Porta

Porta is a modular, provider-neutral agent harness for models, tools, runtimes, sandboxes, approvals, and frontends. It provides a domain-neutral capability-based core with stable contracts, explicit composition, and replaceable adapters.

**Coffee Maker Studio**

The initial foundation is headless. It includes runtime-validated contracts, side-effect-free plugin validation and load planning, capability resolution, plugin lifecycle primitives, session orchestration, cancellation and deadlines, canonical errors, and deterministic in-memory adapters.

Plugin activation follows `validate -> qualify -> resolve -> plan -> activate`. Manifests are validated and planned from immutable serializable snapshots before plugin methods are called. Independent plugins are ordered lexically by ID; dependencies always precede dependents.

The first production model adapter is optional Ollama support in `src/adapters/model-ollama.ts`. Construct it with validated `{ baseUrl, model, timeoutMs? }` configuration. It uses Ollama's native `/api/chat` streaming endpoint and `/api/tags` health check, currently exposing only text and streaming capabilities. Tool calling, vision, structured output, embeddings, model management, and automatic model installation are not implemented.

The live smoke test is opt-in with `RUN_OLLAMA_INTEGRATION_TESTS=1`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL`; it never downloads models.

Provider health is generic and diagnostic: `unreachable`, `resource-unavailable`, `invalid-response`, `provider-error`, and `timeout` are available as optional health reasons. Static plugin qualification does not perform health checks or network I/O.

Runtime execution is modeled as a `RuntimeExecution` lifecycle object rather than a one-shot result. It exposes ordered runtime events, a result, cancellation, and optional stdin. `RuntimeHost` owns execution mechanics; `SandboxProvider` owns enforcement capabilities and session cleanup. `RuntimeCoordinator` rejects unsupported denied guarantees before creating either resource, so policy enforcement fails closed. The semantic policy dimensions are filesystem data access, network access, and additional code loading, each with `allow`, `deny`, or `best-effort` access and explicit sandbox enforcement levels. The initial authorized source/artifact is not additional code; `codeLoading` governs loading executable code beyond it. Thus `filesystem: deny` and `codeLoading: allow` are independent, while `codeLoading: deny` expresses the stronger no-additional-code guarantee.

`MockRuntime` and `MockSandbox` provide deterministic, headless qualification fixtures only. No concrete runtime, subprocess, network, or OS sandbox is included.

Tools use provider-scoped canonical identities such as `provider-a/echo`; display names are not routing identities. `ToolDescriptor.inputSchema`, invocation input, and results are serializable `JsonValue` values. Providers own validation of tool-specific arguments, while the generic router validates envelopes, resolves identity, normalizes malformed results, and does not retry. Tool discovery is runtime behavior and remains separate from side-effect-free plugin preflight.

MCP is integrated as an optional stdio-only `MCPToolProvider` using the official `@modelcontextprotocol/sdk` client. Configure an explicit provider ID, executable command, arguments, working directory, and environment. The adapter maps `tools/list` and `tools/call` into canonical tool contracts; Streamable HTTP and other MCP features are intentionally not implemented. The real stdio qualification fixture is opt-in with `RUN_MCP_INTEGRATION_TESTS=1`.

Agent execution is a provider-neutral loop over `ModelProvider` and `ToolRouter`. It owns canonical tool-call IDs, sequential tool execution, tool-result correlation, execution-local deduplication, step/tool-call limits, cancellation, deadlines, and lifecycle events. Tool failures are model-visible results; global cancellation, deadlines, malformed model calls, and limits terminate the execution. No model adapter or protocol adapter is invoked directly by the orchestrator.

Porta conversation sessions own completed semantic turns in an in-memory `ConversationStore`. Each execution receives an immutable history snapshot and successful turns commit structured user, assistant, tool-call, and tool-result messages atomically. `conversation.maxTurns` provides coarse deterministic context budgeting by dropping only oldest complete turns; history is not persisted across restarts and is not summarized.

Optional filesystem tools can be enabled with `filesystem.root`. They provide `filesystem/read_file`, `filesystem/list_directory`, and `filesystem/stat` under a confined root. Mutation remains disabled unless `filesystem.mutation.enabled` is explicitly set; when enabled, `filesystem/write_file` and `filesystem/patch_file` use atomic, hash-checked updates. Mutation limits default to 2 MiB writes and 8 MiB patch targets. File summaries use a generic content-reduction boundary. Agent-authored notes are provided separately by session-scoped `scratchpad/write`, `scratchpad/append`, `scratchpad/read`, and `scratchpad/list`; scratchpad contents remain off-context until explicitly read and are not persisted across restarts.

Conversation compaction is opt-in with `conversation.maxTurns` plus `conversation.compaction.enabled`. It derives a summary for execution context, retains recent complete turns, and adds a bounded scratchpad manifest and recovery hint. Canonical history and scratchpad contents remain unchanged.

Composable search exposes stable `filesystem/search` and `scratchpad/search` tools while the composition root selects the best available backend. CCC is preferred for indexed workspace roots, followed by ripgrep, grep, and a built-in linear engine. Scratchpad search uses the canonical session-scoped store and remains available without an external index.

Controlled command execution is opt-in through `execution.enabled` and requires a configured filesystem root. Commands use direct argv execution, an explicit allowlist, bounded stdout/stderr, workspace-confined cwd, and the existing authorization path. Sandbox selection prefers an available Linux Bubblewrap backend, then safely falls back to the host backend only when the configured policy permits it. Host-process sandboxing is reported honestly as best-effort/unsupported rather than being presented as a hard sandbox. Bubblewrap is optional; it is not required for read-only Porta startup.

Task progress is session-scoped and in-memory. The `task/create`, `task/get`, and versioned `task/update` tools maintain ordered steps, verification criteria, immutable evidence, and completion guards. Task state is injected as bounded control context and survives conversation compaction independently of conversation history.

Local Git inspection is opt-in through `git.enabled` and exposes structured `git/status`, `git/diff`, `git/show`, and `git/log` tools. The CLI backend uses direct argv, `GIT_TERMINAL_PROMPT=0`, bounded output, and the configured workspace as the repository root. Remote operations and commits are intentionally not implemented.

Durable state is opt-in through `persistence.enabled`. The SQLite adapter stores conversation turns, scratchpad entries, task/evidence state, and immutable artifact payloads under the configured workspace (for example `.porta/porta.db`). Use `PORTA_SESSION=<id>` or `--session <id>` with the terminal to resume an existing open session. SQLite persistence uses plaintext local storage and requires a Node runtime with `node:sqlite`; memory stores remain the default.

Large execution output is retained as an immutable artifact when it exceeds the contextual output bound. Use `artifact/stat`, `artifact/search`, and bounded `artifact/read` explicitly; full artifact contents are never automatically injected into model context. Artifacts are session-scoped and support SHA-256 integrity metadata.

The deterministic self-qualification E2E in `tests/e2e.test.ts` drives a broken temporary Git repository through task creation, search/read, failing and passing execution, artifact recovery, scratchpad notes, compaction, filesystem patching, Git verification, evidence guards, SQLite restart/resume, and approval denial. It uses the canonical ToolRouter path and does not require Ollama, CCC, network access, or Bubblewrap.

Run `npm install`, then `npm test`, `npm run typecheck`, and `npm run build`.

Optional real-model qualification runs only when explicitly requested:

```bash
OLLAMA_MODEL="your-configured-model" npm run qualify:live
```

It uses three fresh temporary local Git fixtures (localized bug, cross-file discovery, and large diagnostic artifact), normal Porta composition, bounded budgets, and writes JSON reports under `.tmp/porta-qualification/`. Compaction is enabled in the live configuration; dedicated persisted-resume qualification remains deferred. It is not part of the default test suite and requires no remote repository or network Git.

## Local terminal application

Start Porta with `npm run porta`. The legacy `npm run harness` command remains an alias. It requires `OLLAMA_MODEL`; `OLLAMA_BASE_URL` defaults to `http://localhost:11434`. Alternatively set `PORTA_CONFIG` to a JSON file (the deprecated `HARNESS_CONFIG` variable remains a fallback) using the `model`, optional `tools` (MCP stdio), `authorization.mode` (`require-approval` or `allow-all`), optional agent limits, and `conversation.maxTurns` for deterministic context budgeting. For example:

```json
{"model":{"provider":"ollama","baseUrl":"http://localhost:11434","model":"your-local-model"},"authorization":{"mode":"require-approval"},"conversation":{"maxTurns":32},"tools":[]}
```

The shell streams canonical application events, accepts `y`/`yes` for approval, denies other approval input (including EOF), accepts `/cancel`, and treats EOF as graceful shutdown. A built invocation is `npm run build && node dist/src/main.js`.
