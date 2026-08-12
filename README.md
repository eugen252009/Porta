# Generic Agent Harness

A domain-neutral, capability-based harness with a small microkernel, stable contracts, explicit composition, and replaceable adapters.

The initial foundation is headless. It includes runtime-validated contracts, side-effect-free plugin validation and load planning, capability resolution, plugin lifecycle primitives, session orchestration, cancellation and deadlines, canonical errors, and deterministic in-memory adapters.

Plugin activation follows `validate -> qualify -> resolve -> plan -> activate`. Manifests are validated and planned from immutable serializable snapshots before plugin methods are called. Independent plugins are ordered lexically by ID; dependencies always precede dependents.

The first production model adapter is optional Ollama support in `src/adapters/model-ollama.ts`. Construct it with validated `{ baseUrl, model, timeoutMs? }` configuration. It uses Ollama's native `/api/chat` streaming endpoint and `/api/tags` health check, currently exposing only text and streaming capabilities. Tool calling, vision, structured output, embeddings, model management, and automatic model installation are not implemented.

The live smoke test is opt-in with `RUN_OLLAMA_INTEGRATION_TESTS=1`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL`; it never downloads models.

Provider health is generic and diagnostic: `unreachable`, `resource-unavailable`, `invalid-response`, `provider-error`, and `timeout` are available as optional health reasons. Static plugin qualification does not perform health checks or network I/O.

Runtime execution is modeled as a `RuntimeExecution` lifecycle object rather than a one-shot result. It exposes ordered runtime events, a result, cancellation, and optional stdin. `RuntimeHost` owns execution mechanics; `SandboxProvider` owns enforcement capabilities and session cleanup. `RuntimeCoordinator` rejects unsupported denied guarantees before creating either resource, so policy enforcement fails closed. The semantic policy dimensions are filesystem data access, network access, and additional code loading, each with `allow`, `deny`, or `best-effort` access and explicit sandbox enforcement levels. The initial authorized source/artifact is not additional code; `codeLoading` governs loading executable code beyond it. Thus `filesystem: deny` and `codeLoading: allow` are independent, while `codeLoading: deny` expresses the stronger no-additional-code guarantee.

`MockRuntime` and `MockSandbox` provide deterministic, headless qualification fixtures only. No concrete runtime, subprocess, network, or OS sandbox is included.

Tools use provider-scoped canonical identities such as `provider-a/echo`; display names are not routing identities. `ToolDescriptor.inputSchema`, invocation input, and results are serializable `JsonValue` values. Providers own validation of tool-specific arguments, while the generic router validates envelopes, resolves identity, normalizes malformed results, and does not retry. Tool discovery is runtime behavior and remains separate from side-effect-free plugin preflight.

MCP is integrated as an optional stdio-only `MCPToolProvider` using the official `@modelcontextprotocol/sdk` client. Configure an explicit provider ID, executable command, arguments, working directory, and environment. The adapter maps `tools/list` and `tools/call` into canonical tool contracts; Streamable HTTP and other MCP features are intentionally not implemented. The real stdio qualification fixture is opt-in with `RUN_MCP_INTEGRATION_TESTS=1`.

Run `npm install`, then `npm test`, `npm run typecheck`, and `npm run build`.
