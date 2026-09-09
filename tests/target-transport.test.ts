import { describe, expect, it } from "vitest";
import { InMemoryTargetTransport, AuthenticatedTargetTransport, targetRequest } from "../src/target-transport.js";
import { RemoteExecutionTarget } from "../src/target.js";

describe("remote execution target transport", () => {
  const description = { id: "pc-test", kind: "test", available: true, capabilities: ["filesystem.read", "filesystem.write", "execution.run"] as const, workspace: { id: "pc-workspace", path: "/independent/pc/workspace" }, platform: "test" };

  it("authenticates, discovers capabilities, and routes independent workspace operations", async () => {
    const transport = new InMemoryTargetTransport(description, { "package.json": "target-package" });
    let authCalls = 0;
    const authenticated = new AuthenticatedTargetTransport(transport, { targetId: "pc-test", challenge: "challenge", identity: "client", signature: "signature" }, async (proof) => { authCalls++; return proof.targetId === "pc-test"; });
    const target = new RemoteExecutionTarget("pc-test", "test", authenticated);
    expect(await target.available()).toBe(true);
    expect(await target.capabilities()).toEqual(description.capabilities);
    expect((await target.invoke("filesystem.read", { path: "package.json" })).output).toEqual({ path: "package.json", content: "target-package" });
    expect((await target.invoke("filesystem.write", { path: ".porta-target-qualification/test.txt", content: "ok" })).status).toBe("completed");
    expect((await target.invoke("filesystem.read", { path: ".porta-target-qualification/test.txt" })).output).toMatchObject({ content: "ok" });
    expect((await target.invoke("filesystem.delete", { path: ".porta-target-qualification/test.txt" })).status).toBe("completed");
    expect((await target.invoke("execution.run", { command: "pwd" })).output).toMatchObject({ cwd: "/independent/pc/workspace" });
    expect(authCalls).toBe(1);
  });

  it("rejects outside-root paths and unsupported commands", async () => {
    const target = new RemoteExecutionTarget("pc-test", "test", new InMemoryTargetTransport(description));
    expect((await target.invoke("filesystem.read", { path: "../outside" })).status).toBe("failed");
    expect((await target.invoke("execution.run", { command: "sh" })).status).toBe("failed");
  });

  it("honors cancellation and deadlines at the transport boundary", async () => {
    const transport = new InMemoryTargetTransport(description);
    const request = targetRequest("pc-test", "pc-workspace", "execution.run", { command: "pwd" });
    await transport.cancel(request.requestId);
    expect((await transport.invoke(request)).status).toBe("cancelled");
    const expired = targetRequest("pc-test", "pc-workspace", "execution.run", { command: "pwd" }, Date.now() - 1);
    expect((await transport.invoke(expired)).status).toBe("timed-out");
  });

  it("reports target unavailability without changing identity", async () => {
    const unavailable = { ...description, available: false };
    const target = new RemoteExecutionTarget("pc-test", "test", new InMemoryTargetTransport(unavailable));
    expect(await target.available()).toBe(false);
    expect(target.id).toBe("pc-test");
  });
});
