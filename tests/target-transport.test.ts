import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTargetTransport, AuthenticatedTargetTransport, HttpTargetTransport, createTargetTransportServer, targetRequest } from "../src/target-transport.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { RemoteExecutionTarget, RemoteDevelopmentReleaseTarget } from "../src/target.js";
import type { GitBackend } from "../src/git.js";
import type { ImageAdapter } from "../src/deployment.js";
import { ToolProviderTargetTransport } from "../src/target-transport.js";

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

  it("uses the real HTTP transport with Ed25519 challenge authentication", async () => {
    const serverDir = mkdtempSync(join(tmpdir(), "porta-target-server-")); const clientDir = mkdtempSync(join(tmpdir(), "porta-target-client-"));
    const serverIdentity = new InstanceIdentityStore(serverDir); const clientIdentity = new InstanceIdentityStore(clientDir); const operations = new InMemoryTargetTransport(description, { "package.json": "network-target" });
    const server = createTargetTransportServer({ target: description, identity: serverIdentity, operations, allowedIdentities: [clientIdentity.public] }); const address = await server.listen();
    try {
      const transport = new HttpTargetTransport({ endpoint: `http://${address.host}:${address.port}`, clientIdentity }); const target = new RemoteExecutionTarget("pc-test", "test", transport);
      expect(await target.available()).toBe(true); expect((await target.invoke("filesystem.read", { path: "package.json" })).output).toMatchObject({ content: "network-target" });
    } finally { await server.close(); rmSync(serverDir, { recursive: true, force: true }); rmSync(clientDir, { recursive: true, force: true }); }
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

  it("routes typed Git and image release operations with structured results", async () => {
    const releaseDescription = { ...description, capabilities: ["git.commit", "git.push", "image.build", "image.push"] as const };
    const git = { async commit(input: { message: string }) { return { revision: "new-head", subject: input.message }; }, async push() { return { remote: "origin", branch: "main", revision: "new-head" }; } } as unknown as GitBackend;
    const image = { async build(sourceRevision: string, tag: string) { return { repository: "registry/porta", tag, reference: `registry/porta:${tag}`, sourceRevision }; }, async push(identity: any) { return { ...identity, digest: "sha256:digest", latestReference: "registry/porta:latest" }; } } as ImageAdapter;
    const transport = new ToolProviderTargetTransport(releaseDescription, { git, image });
    const target = new RemoteExecutionTarget("pc-test", "test", transport);
    const release = new RemoteDevelopmentReleaseTarget(target, "porta", "registry");
    expect(await release.commit({ message: "qualification", expectedRevision: "old-head" })).toMatchObject({ revision: "new-head", subject: "qualification" });
    expect(await release.push({ revision: "new-head" })).toMatchObject({ remote: "origin", branch: "main", revision: "new-head" });
    expect(await release.build({ revision: "new-head", tag: "new-head" })).toMatchObject({ sourceRevision: "new-head", tag: "new-head" });
    expect(await release.pushImage({ reference: "registry/porta:new-head", repository: "registry/porta", tag: "new-head", sourceRevision: "new-head" })).toMatchObject({ digest: "sha256:digest", latestReference: "registry/porta:latest" });
  });

  it("reports target unavailability without changing identity", async () => {
    const unavailable = { ...description, available: false };
    const target = new RemoteExecutionTarget("pc-test", "test", new InMemoryTargetTransport(unavailable));
    expect(await target.available()).toBe(false);
    expect(target.id).toBe("pc-test");
  });
});
