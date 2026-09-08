# Porta

Porta is a modular, provider-neutral agent harness for models, tools, runtimes, sandboxes, approvals, and frontends. It provides a domain-neutral capability-based core with stable contracts, explicit composition, and replaceable adapters.

**Coffee Maker Studio**

The initial foundation is headless. It includes runtime-validated contracts, side-effect-free plugin validation and load planning, capability resolution, plugin lifecycle primitives, session orchestration, cancellation and deadlines, canonical errors, and deterministic in-memory adapters.

Plugin activation follows `validate -> qualify -> resolve -> plan -> activate`. Manifests are validated and planned from immutable serializable snapshots before plugin methods are called. Independent plugins are ordered lexically by ID; dependencies always precede dependents.

The first production model adapter is optional Ollama support in `src/adapters/model-ollama.ts`. Construct it with validated `{ baseUrl, model, timeoutMs? }` configuration. It uses Ollama's native `/api/chat` streaming endpoint and `/api/tags` health check, exposing `model.text`, `model.streaming`, and — for models with native tool calling (`supports_tools`, detected at runtime) — `model.tools`. Vision, structured output, embeddings, model management, and automatic model installation are not implemented.

A second bundled adapter, `src/adapters/model-openai-compatible.ts`, targets any OpenAI-compatible `/v1/chat/completions` server such as a local llama.cpp `llama-server`. Select it with `model.provider: "openai-compatible"` or `PORTA_MODEL_PROVIDER=openai-compatible` plus `PORTA_MODEL_BASE_URL` (default `http://127.0.0.1:8080`) and `PORTA_MODEL`. It streams SSE, accumulates fragmented `tool_calls` deltas into canonical calls, ignores non-canonical reasoning fields, supports an optional `apiKey` bearer token, and health-checks `/v1/models` by model id or alias. Both adapters expose the same capability-gated `model.tools` surface.

A third optional adapter, `src/adapters/model-openai-codex.ts`, uses **ChatGPT/Codex subscription login**, not an OpenAI API key. It supports streaming text and canonical tool calls over the Codex Responses endpoint, while Porta retains control of tool execution and approvals. OAuth browser/PKCE and device-code login/refresh use the pinned `@earendil-works/pi-ai` library. See [Codex subscription login](#codex-subscription-login). No existing Codex or pi credentials are automatically imported.

Live smoke tests are opt-in: `RUN_OLLAMA_INTEGRATION_TESTS=1` with `OLLAMA_BASE_URL`/`OLLAMA_MODEL`, or `RUN_OPENAI_COMPATIBLE_INTEGRATION_TESTS=1` with `PORTA_MODEL_BASE_URL`/`PORTA_MODEL`. They never download models.

Provider health is generic and diagnostic: `unreachable`, `resource-unavailable`, `invalid-response`, `provider-error`, and `timeout` are available as optional health reasons. Static plugin qualification does not perform health checks or network I/O.

Runtime execution is modeled as a `RuntimeExecution` lifecycle object rather than a one-shot result. It exposes ordered runtime events, a result, cancellation, and optional stdin. `RuntimeHost` owns execution mechanics; `SandboxProvider` owns enforcement capabilities and session cleanup. `RuntimeCoordinator` rejects unsupported denied guarantees before creating either resource, so policy enforcement fails closed. The semantic policy dimensions are filesystem data access, network access, and additional code loading, each with `allow`, `deny`, or `best-effort` access and explicit sandbox enforcement levels. The initial authorized source/artifact is not additional code; `codeLoading` governs loading executable code beyond it. Thus `filesystem: deny` and `codeLoading: allow` are independent, while `codeLoading: deny` expresses the stronger no-additional-code guarantee.

`MockRuntime` and `MockSandbox` provide deterministic, headless qualification fixtures. Concrete adapters are bundled: `HostProcessRuntime` with the host-process sandbox (best-effort enforcement, reported honestly), `DenoRuntime` for Deno subprocess execution, and the Linux-only `BubblewrapSandbox` for true isolation. The composition root selects Bubblewrap when available and safely falls back to the host backend only when the policy permits it.

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

For a practical guide to using the CLI, TUI, and web frontend, see [docs/USAGE.md](docs/USAGE.md).

## Installation and starting Porta

Porta is currently distributed as a Node.js package. Node.js 22.19 or newer is required (the OAuth dependency requires 22.19; SQLite persistence uses the built-in `node:sqlite` API). npm is the reference package manager; Yarn and Bun can install and run the same package because they consume standard npm packages. Deno is supported as an execution backend, but is not the recommended launcher for Porta itself because the CLI uses Node APIs and Ink.

### Start from a checkout

Porta needs a model provider. For the default Ollama provider:

```bash
npm install
ollama serve                         # in another terminal
ollama pull your-model
OLLAMA_MODEL=your-model npm run porta
```

Alternatively, create a JSON configuration and point Porta at it:

```json
{"model":{"provider":"ollama","baseUrl":"http://localhost:11434","model":"your-model"},"authorization":{"mode":"require-approval"},"tools":[]}
```

```bash
PORTA_CONFIG=porta.json npm run porta
```

The browser frontend starts with `PORTA_CONFIG=porta.json npm run porta:web` and listens on `http://127.0.0.1:4173`. To resume a persisted session, enable SQLite persistence in the configuration and use `PORTA_SESSION=<id>` or `npm run porta -- --session <id>`.

### Codex subscription login

Sign in explicitly using an eligible ChatGPT account with Codex access:

```bash
npm run porta -- login openai-codex
# For SSH/headless environments (requires device-code login enabled on your account):
npm run porta -- login openai-codex --device-code

PORTA_MODEL_PROVIDER=openai-codex PORTA_MODEL=gpt-5.3-codex npm run porta
# The same environment works with npm run porta:tui or npm run porta:web.
```

Browser login prints a URL to open and uses a loopback callback on port 1455, with a manual callback-URL fallback. Device login prints a verification URL and short code. Ctrl-C cancels; login is bounded to 15 minutes. Login commands run before loading model configuration, so they need no model/server configuration. Installed-package equivalents are `porta login openai-codex` and `porta logout openai-codex`.

Alternatively configure:

```json
{"model":{"provider":"openai-codex","model":"gpt-5.3-codex","timeoutMs":120000},"authorization":{"mode":"require-approval"}}
```

#### Enable workspace tools explicitly

The model-only commands/configuration above **do not grant filesystem access**. With no `PORTA_CONFIG`, the CLI registers 12 tools: `artifact/list`, `artifact/read`, `artifact/search`, `artifact/stat`, `scratchpad/append`, `scratchpad/list`, `scratchpad/read`, `scratchpad/search`, `scratchpad/write`, `task/create`, `task/get`, and `task/update`. Scratchpad notes are not workspace files. `porta-tui.json` is not loaded automatically.

For file creation and read-back, create a configuration such as `porta-workspace.json`:

```json
{
  "filesystem": { "root": ".", "mutation": { "enabled": true } },
  "authorization": { "mode": "require-approval" }
}
```

```bash
PORTA_CONFIG=porta-workspace.json \
PORTA_MODEL_PROVIDER=openai-codex PORTA_MODEL=gpt-5.6-sol npm run porta
```

Set `filesystem.root` to the intended workspace (or an empty temporary directory for a smoke test). The CLI now advertises **18 tools**, including `filesystem/read_file` and `filesystem/write_file`; approve the write and read when prompted. Try: `Create a file named porta-live.txt containing PORTA_TOOL_OK. Read the file back and reply only with its contents.` Verify the `[tool completed] filesystem/write_file` and `filesystem/read_file` events and the actual file, not just the assistant's claim. Existing files are not silently overwritten in create mode.

`filesystem.root` alone enables four read-only tools; `filesystem.mutation.enabled: true` adds write and patch. No runtime or shell is needed for filesystem tools. Command execution remains a separate opt-in (`execution.enabled`, workspace root, command allowlist, and sandbox policy). These settings use the existing generic providers and work identically for terminal and web frontends; they are not Codex protocol options.

An opt-in live regression exercises the same composition with a real subscription and a fresh temporary workspace:

```bash
RUN_CODEX_TOOL_INTEGRATION_TESTS=1 PORTA_MODEL=gpt-5.6-sol npx vitest run tests/codex-tools-live.test.ts
```

It approves only the requested file's create/read operations, verifies successful tool results and actual disk contents, and removes the temporary workspace afterward. This spends subscription quota; it is skipped by default. It is separate from the local-model `qualify:live` command.

Use a model available to your account; the example is not an entitlement guarantee. Subscription usage limits apply, not ordinary OpenAI API credits. This third-party integration depends on OpenAI's access policies and Codex backend behavior, which can change. There is **no API-key fallback**. `apiKey` and `baseUrl` are rejected for this provider; the HTTPS endpoint is fixed and redirects are disabled. `PORTA_MODEL_BASE_URL` and `OPENAI_API_KEY` are not used by Codex.

Credentials are stored separately from conversations/workspaces in `~/.porta/auth/openai-codex.json`. Set `PORTA_AUTH_DIR` to a dedicated private directory to override it (for both login and application startup). Credentials stay on the server for the web frontend; the browser has no auth-management endpoint. Storage uses a mode-0700 directory, mode-0600 file, atomic replacement, and a cross-process refresh lock. Expiring tokens refresh automatically. This is **plaintext local storage**, not a keychain or protection against other processes/tools running as your user. Do not commit, share, or place it in an agent-accessible workspace. Windows credential persistence is currently unsupported: Porta fails closed rather than claiming POSIX modes enforce Windows ACLs.

`npm run porta -- logout openai-codex` removes only Porta's local credentials; it does not revoke tokens on OpenAI's servers or sign other clients out. Corrupt/insecure files are not silently overwritten. After a process crash, an `openai-codex.lock` directory may remain; remove that lock only after confirming no Porta login/refresh is running. Lock acquisition fails after 10 seconds rather than stealing a potentially live lock.

Generation defaults to a 120-second timeout (also bounded by the execution deadline), 4 MiB request bodies, 8 MiB streamed responses (`model.maxResponseBytes` can override this up to 64 MiB), and at most 128 returned tool calls before Porta's stricter agent limits apply. Failed/truncated responses do not release tool calls for execution. Reasoning, vision, usage accounting, model discovery, automatic retries, and provider-native reasoning-state persistence are not implemented. Startup health checks credential readiness (possibly refreshing an expired token), not model entitlement or quota. Normal tests mock OAuth/backend HTTP; local live qualification deliberately excludes subscription providers and never spends subscription quota.

### Install as a package

The package exposes a `porta` executable. Before it is published through TPAHub, create and install a local tarball to exercise the same distribution path:

```bash
npm pack
npm install --global ./porta-0.1.0.tgz
OLLAMA_MODEL=your-model porta
```

TPAHub should publish and sign this npm-compatible tarball (or expose it through its own registry), rather than maintaining a separate apt-specific build. Users can then install it with `npm install --global <tpahub-porta-package>` or run it ephemerally with `npx <tpahub-porta-package>`. Yarn and Bun equivalents are `yarn global add <tpahub-porta-package>` and `bun add --global <tpahub-porta-package>`.

### Distribution recommendation

For the current Node/TypeScript CLI, an npm-compatible package is the simplest and best first distribution: it reuses the existing build, dependency, and executable model, works with npm/Yarn/Bun, and lets TPAHub remain the authoritative discovery, versioning, and artifact distribution layer. An apt package would duplicate platform-specific packaging and upgrade/signing infrastructure and should wait until there is a stable Debian support commitment or a self-contained native binary. If a system-level installer is later needed, TPAHub can provide a thin apt/Homebrew wrapper that installs the pinned npm artifact; it should not become a second source of package contents.

Optional real-model qualification runs only when explicitly requested:

```bash
OLLAMA_MODEL="your-configured-model" npm run qualify:live
```

or against a local OpenAI-compatible server such as llama.cpp:

```bash
PORTA_MODEL_PROVIDER=openai-compatible PORTA_MODEL_BASE_URL=http://127.0.0.1:8080 PORTA_MODEL=your-model npm run qualify:live
```

It uses three fresh temporary local Git fixtures (localized bug, cross-file discovery, and large diagnostic artifact), normal Porta composition, bounded budgets, and writes JSON reports under `.tmp/porta-qualification/`. Compaction is enabled in the live configuration; dedicated persisted-resume qualification remains deferred. It is not part of the default test suite and requires no remote repository or network Git. Budgets are overridable for slower local models via `PORTA_QUALIFICATION_MAX_TURNS`, `PORTA_QUALIFICATION_MAX_TOOL_CALLS`, `PORTA_QUALIFICATION_MAX_EXECUTIONS`, `PORTA_QUALIFICATION_MAX_MUTATIONS`, and `PORTA_QUALIFICATION_MAX_DURATION_MS`.

## Local terminal application

Start Porta with `npm run porta`. The legacy `npm run harness` command remains an alias. The default provider is Ollama (`OLLAMA_MODEL`; `OLLAMA_BASE_URL` defaults to `http://localhost:11434`); set `PORTA_MODEL_PROVIDER=openai-compatible` with `PORTA_MODEL` and optional `PORTA_MODEL_BASE_URL` (default `http://127.0.0.1:8080`) to use a local OpenAI-compatible server instead. Alternatively set `PORTA_CONFIG` to a JSON file (the deprecated `HARNESS_CONFIG` variable remains a fallback) using the `model`, optional `tools` (MCP stdio), `authorization.mode` (`require-approval` or `allow-all`), optional agent limits, and `conversation.maxTurns` for deterministic context budgeting. For example:

```json
{"model":{"provider":"ollama","baseUrl":"http://localhost:11434","model":"your-local-model"},"authorization":{"mode":"require-approval"},"conversation":{"maxTurns":32},"tools":[]}
```

At startup the terminal lists registered canonical tool IDs (bounded to 64 entries), the tool count, filesystem access level, and whether command execution is available. It does not dump configuration, schemas, or credentials. A disabled-filesystem notice explains the explicit `PORTA_CONFIG` settings needed for file creation; selecting a model alone never grants workspace access.

The shell streams canonical application events, accepts `y`/`yes` for approval, denies other approval input (including EOF), accepts `/cancel`, and treats EOF as graceful shutdown. A built invocation is `npm run build && node dist/src/main.js`.

### Local browser application

Start the browser UI with `PORTA_CONFIG=porta-tui.json npm run porta:web`, then open `http://127.0.0.1:4173`. The server binds to localhost only, streams canonical gateway events over newline-delimited HTTP responses, and keeps model and filesystem access on the server. Set `PORTA_WEB_PORT` to use another local port. Filesystem paths are relative to the configured `filesystem.root`; the bundled `porta-tui.json` uses the current working directory.
