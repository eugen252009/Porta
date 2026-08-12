# Generic Agent Harness

A domain-neutral, capability-based harness with a small microkernel, stable contracts, explicit composition, and replaceable adapters.

The initial foundation is headless. It includes runtime-validated contracts, side-effect-free plugin validation and load planning, capability resolution, plugin lifecycle primitives, session orchestration, cancellation and deadlines, canonical errors, and deterministic in-memory adapters.

Plugin activation follows `validate -> qualify -> resolve -> plan -> activate`. Manifests are validated and planned from immutable serializable snapshots before plugin methods are called. Independent plugins are ordered lexically by ID; dependencies always precede dependents.

Run `npm install`, then `npm test`, `npm run typecheck`, and `npm run build`.
