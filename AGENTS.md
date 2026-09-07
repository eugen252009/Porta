# AGENTS.md

## Project overview

Porta is a provider-neutral TypeScript agent harness. It composes model providers, tools, runtimes, sandboxes, authorization, persistence, and terminal/web frontends behind explicit contracts. Keep the core domain-neutral and avoid coupling it to one model vendor, protocol, or runtime.

Read `README.md` before making architectural changes; it documents the supported behavior and intentional non-features.

## Repository layout

- `src/contracts.ts` — shared serializable contracts and public types.
- `src/kernel.ts`, `src/composition.ts`, `src/plugin-preflight.ts` — plugin validation, capability resolution, planning, and lifecycle.
- `src/agent.ts`, `src/conversation.ts`, `src/compaction.ts` — model/tool orchestration and session history.
- `src/tools.ts`, `src/adapters/tool-mcp.ts` — canonical tool routing and optional MCP stdio integration.
- `src/runtime.ts`, `src/execution.ts`, `src/sandbox-selection.ts` — runtime execution, policy, and sandbox selection.
- `src/filesystem.ts`, `src/mutation.ts`, `src/search.ts`, `src/scratchpad.ts`, `src/task.ts`, `src/artifact.ts` — opt-in workspace/session capabilities.
- `src/adapters/` — replaceable model, runtime, and sandbox implementations.
- `src/*-mocks.ts` and `tests/` — deterministic fixtures and behavioral tests.
- `web/` — browser frontend assets.

`src/index.ts` is the public export barrel. Update it when adding a public module.

## Development commands

Run from the repository root:

```bash
npm install
npm test                 # full deterministic test suite
npm run typecheck        # strict TypeScript check
npm run build            # emits declarations and JS to dist/
npm run porta            # build and start terminal application
npm run porta:web        # build and start browser application
npm run qualify:live     # opt-in local-model qualification
```

Use Vitest filters for focused work, for example `npx vitest run tests/agent.test.ts`. The live qualification command requires an explicitly configured local model and is not part of normal tests. Do not add tests that require network access, downloaded models, Ollama, Bubblewrap, or external services by default.

## TypeScript and implementation conventions

- The project uses ESM (`"type": "module"`) with `NodeNext`; relative TypeScript imports use their emitted `.js` extension.
- Strict mode and `noUncheckedIndexedAccess` are enabled. Preserve type safety rather than weakening compiler options.
- Prefer small, pure functions and explicit serializable data at boundaries. Make ownership, cancellation, deadlines, limits, and failure modes explicit.
- Preserve canonical provider-scoped identities such as `provider-a/echo`; display names are not routing identities.
- Keep model adapters and protocol adapters behind `ModelProvider`/tool contracts. The orchestrator must not call vendor or protocol APIs directly.
- Keep validation and planning side-effect-free. The activation flow is `validate -> qualify -> resolve -> plan -> activate`.
- Keep runtime mechanics separate from sandbox policy/enforcement. Report host-process enforcement honestly as best-effort; do not present it as isolation.
- Confine filesystem paths to the configured workspace root, use bounded output/inputs, and fail closed when an authorization or guarantee cannot be enforced.
- Preserve atomic/versioned behavior for mutations and persistence. Never silently overwrite changed content.
- Keep large outputs in artifacts and expose bounded reads/searches instead of injecting them wholesale into model context.

## Testing expectations

Every behavior change should include or update deterministic tests, including malformed inputs, authorization failures, cancellation/deadlines, limits, path traversal, provider errors, and persistence/restart cases where relevant. Prefer mocks and temporary local fixtures. Run at least `npm test` and `npm run typecheck` before delivery; run `npm run build` when changing public types, exports, or build/runtime behavior.

The E2E qualification in `tests/e2e.test.ts` exercises the integrated task, search, execution, artifact, compaction, Git, mutation, persistence, and approval paths. Keep it local and deterministic.

## Scope and change discipline

- Do not introduce a new provider-specific abstraction when an existing contract can be composed.
- Keep optional capabilities opt-in and preserve safe defaults: no model downloads, no remote Git, no mutation, no command execution, and no persistence unless configured.
- Update `README.md` when supported behavior, configuration, commands, or intentional limitations change.
- Avoid committing generated output (`dist/`, `.tmp/`, `.cocoindex_code/`) or dependency directories.
- Check `git diff` and `git status` before finishing, and keep unrelated changes out of the patch.
