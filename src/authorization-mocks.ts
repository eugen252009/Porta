import { ApprovalProvider, ToolApprovalRequest, ToolAuthorizationDecision, ToolAuthorizationPolicy, ToolAuthorizationRequest } from "./contracts.js";

export class AllowAllToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  async authorize(_request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> { return "allow"; }
}

export class StaticToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  constructor(private readonly decision: ToolAuthorizationDecision) {}
  async authorize(_request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> { return this.decision; }
}

export class StaticApprovalProvider implements ApprovalProvider {
  readonly requests: ToolApprovalRequest[] = [];
  constructor(private readonly approved = true, private readonly reason?: string) {}
  async approve(request: ToolApprovalRequest) { this.requests.push(request); return { approved: this.approved, ...(this.reason ? { reason: this.reason } : {}) }; }
}
