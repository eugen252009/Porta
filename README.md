# Generic Agent Harness

A domain-neutral, capability-based harness with a small microkernel, stable contracts, explicit composition, and replaceable adapters.

The initial foundation is headless. It includes runtime-validated contracts, side-effect-free plugin validation and load planning, capability resolution, plugin lifecycle primitives, session orchestration, cancellation and deadlines, canonical errors, and deterministic in-memory adapters.

Plugin activation follows `validate -> qualify -> resolve -> plan -> activate`. Manifests are validated and planned from immutable serializable snapshots before plugin methods are called. Independent plugins are ordered lexically by ID; dependencies always precede dependents.

The first production model adapter is optional Ollama support in `src/adapters/model-ollama.ts`. Construct it with validated `{ baseUrl, model, timeoutMs? }` configuration. It uses Ollama's native `/api/chat` streaming endpoint and `/api/tags` health check, currently exposing only text and streaming capabilities. Tool calling, vision, structured output, embeddings, model management, and automatic model installation are not implemented.

The live smoke test is opt-in with `RUN_OLLAMA_INTEGRATION_TESTS=1`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL`; it never downloads models.

Provider health is generic and diagnostic: `unreachable`, `resource-unavailable`, `invalid-response`, `provider-error`, and `timeout` are available as optional health reasons. Static plugin qualification does not perform health checks or network I/O.

Run `npm install`, then `npm test`, `npm run typecheck`, and `npm run build`.
