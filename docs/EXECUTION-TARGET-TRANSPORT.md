# Execution target transport

Phase 4C adds a small target transport seam without introducing a live network server.

`TargetTransport` supports:

- authenticated target description and capability discovery;
- stable target/workspace identity;
- bounded filesystem read/write/delete and command operations;
- structured results and normalized status;
- cancellation and deadlines.

`RemoteExecutionTarget` adapts the transport to `ExecutionTarget`. It verifies advertised capabilities before invoking an operation. `AuthenticatedTargetTransport` requires an authenticated proof before using the transport; credentials are not part of task state.

`InMemoryTargetTransport` is an independent deterministic fixture used to prove routing, workspace separation, path/command boundaries, cancellation, deadlines, and stable identity. It is not a claim that a real PC worker is deployed.

The existing HTTP/UI `PortaTarget` remains separate. Git/image release routing and live PC transport remain later work.
