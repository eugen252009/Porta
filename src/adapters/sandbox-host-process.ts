import { ExecutionPolicy, SandboxCapabilities, SandboxProvider, SandboxSession } from "../contracts.js";
import { executionId } from "../runtime.js";

class HostSandboxSession implements SandboxSession { readonly id = executionId(); async dispose(): Promise<void> {} }

/** Host processes are not a hard sandbox; this adapter reports best-effort enforcement honestly. */
export class HostProcessSandbox implements SandboxProvider {
  readonly descriptor = { id: "sandbox.host-process", version: "1" };
  readonly capabilities: SandboxCapabilities = { filesystem: "best-effort", network: "unsupported", codeLoading: "unsupported" };
  async create(_policy: ExecutionPolicy): Promise<SandboxSession> { return new HostSandboxSession(); }
}
