import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApplicationGateway, KernelCommand, PluginRegistrar } from "../src/contracts.js";
import { createHomeAuthAdmissionPlugin, HomeAuthAdmissionAuthenticator, homeAuthPublicKey } from "../src/adapters/auth-homeauth.js";
import { PluginManager } from "../src/kernel.js";
import { createPortaWebServer } from "../src/web-server.js";

const now = 1_800_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

function token(overrides: { v?: number; iat?: number; exp?: number; user?: string; serviceId?: number; key?: KeyObject; cap?: string } = {}): string {
  const serviceId = overrides.serviceId ?? 17;
  const capabilities = Buffer.alloc(Math.floor(serviceId / 8) + 1);
  capabilities[Math.floor(serviceId / 8)] = 1 << (serviceId % 8);
  const payload = Buffer.from(JSON.stringify({ v: overrides.v ?? 1, iat: overrides.iat ?? now / 1000, exp: overrides.exp ?? now / 1000 + 60, user: overrides.user ?? "human:eugen", cap: overrides.cap ?? capabilities.toString("base64url") }));
  return `${payload.toString("base64url")}.${sign(null, payload, overrides.key ?? privateKey).toString("base64url")}`;
}

function authenticator(serviceId = 17, key: KeyObject = publicKey) { return new HomeAuthAdmissionAuthenticator({ publicKey: key, serviceId, now: () => now }); }

describe("HomeAuth admission plugin", () => {
  it("verifies HomeAuth v1 admission tokens and the service capability bit", () => {
    expect(authenticator().authenticate({ authorization: `Bearer ${token()}` })).toEqual({ kind: "human", identity: "homeauth:human:eugen" });
    expect(authenticator().authenticate({ authorization: `Bearer ${token({ user: "service:porta-node" })}` })).toEqual({ kind: "integration", identity: "homeauth:service:porta-node", permissions: [] });
    expect(authenticator(18).authenticate({ authorization: `Bearer ${token()}` })).toBeUndefined();
    expect(authenticator().authenticate({ authorization: "Bearer invalid" })).toBeUndefined();
    expect(authenticator().authenticate({ authorization: undefined })).toBeUndefined();
  });

  const invalidCases: readonly [string, Parameters<typeof token>[0]][] = [
    ["bad signature", { key: other.privateKey }],
    ["expired token", { exp: now / 1000 }],
    ["future token", { iat: now / 1000 + 31 }],
    ["unsupported version", { v: 2 }],
    ["empty subject", { user: "" }],
    ["invalid capability encoding", { cap: "!" }],
  ];
  it.each(invalidCases)("fails closed for %s", (_name, overrides) => {
    expect(authenticator().authenticate({ authorization: `Bearer ${token(overrides)}` })).toBeUndefined();
  });

  it("loads the HomeAuth raw Ed25519 public-key format and rejects other keys", () => {
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    expect(homeAuthPublicKey(raw.toString("base64url")).asymmetricKeyType).toBe("ed25519");
    expect(() => homeAuthPublicKey("not-a-public-key")).toThrow();
    expect(() => new HomeAuthAdmissionAuthenticator({ publicKey: privateKey, serviceId: 17 })).toThrow();
  });

  it("registers the verifier as a resolvable Porta plugin capability", async () => {
    const provider = authenticator();
    const plugin = createHomeAuthAdmissionPlugin(provider);
    const manager = new PluginManager();
    await manager.register([plugin]);
    expect(manager.resolve({ capability: "auth.request-authentication", version: "1" })).toBe(provider);
    expect(manager.resolve({ capability: "auth.missing", optional: true })).toBeUndefined();
    expect(() => manager.resolve({ capability: "auth.missing" })).toThrow();
    await manager.stop([plugin]);
    expect(manager.resolveAll({ capability: "auth.request-authentication", optional: true })).toEqual([]);
    expect(() => manager.resolve({ capability: "auth.request-authentication" })).toThrow();
  });

  it("keeps multiple providers composable while requiring unique resolution", async () => {
    const descriptor = { id: "auth.provider-chain", version: "1" };
    const makePlugin = (id: string, component: object) => ({ manifest: { schemaVersion: 1 as const, id, version: "1", provides: [descriptor], requires: [] }, register(registrar: PluginRegistrar) { registrar.provide(descriptor, component); } });
    const first = {}; const second = {}; const plugins = [makePlugin("auth.first", first), makePlugin("auth.second", second)];
    const manager = new PluginManager();
    await manager.register(plugins);
    expect(manager.resolveAll({ capability: descriptor.id, version: "1" })).toEqual([first, second]);
    expect(() => manager.resolve({ capability: descriptor.id })).toThrow();
    await manager.stop(plugins);
  });

  it("keeps HomeAuth machine admissions out of browser UI and local API authentication", async () => {
    const gateway: ApplicationGateway = { async *execute(_command: KernelCommand) {} };
    const provider = authenticator();
    const server = createPortaWebServer({ gateway, requestAuthenticators: [provider] }, { port: 0 });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const spoofed = await fetch(`${base}/api/identity/allowed`, { headers: { "X-HomeAuth-Subject": "human:attacker", "X-HomeAuth-Kind": "human" } });
      expect(spoofed.status).toBe(401);
      const rejectedGrant = await fetch(`${base}/app`, { headers: { authorization: `Bearer ${token({ serviceId: 18 })}` }, redirect: "manual" });
      expect(rejectedGrant.status).toBe(303);
      const admissionOnly = await fetch(`${base}/app`, { headers: { authorization: `Bearer ${token()}` }, redirect: "manual" });
      expect(admissionOnly.status).toBe(303);
      const status = await fetch(`${base}/auth/status`, { headers: { authorization: `Bearer ${token()}` } });
      expect(await status.json()).toEqual({ configured: false, authenticated: false });
      const api = await fetch(`${base}/api/identity/allowed`, { headers: { authorization: `Bearer ${token()}` } });
      expect(api.status).toBe(401);
      const machine = await fetch(`${base}/app`, { headers: { authorization: `Bearer ${token({ user: "service:fixture" })}` }, redirect: "manual" });
      expect(machine.status).toBe(303);
    } finally {
      await server.close();
    }
  });
});
