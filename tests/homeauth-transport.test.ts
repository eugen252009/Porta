import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAuthAdmissionAuthenticator } from "../src/adapters/auth-homeauth.js";
import { authenticateMaterial } from "../src/request-authentication.js";
import { PluginManager } from "../src/kernel.js";
import { createHomeAuthAdmissionPlugin } from "../src/adapters/auth-homeauth.js";
import type { RequestAuthenticator, RequestPrincipal } from "../src/contracts.js";
import { createPortaWebServer } from "../src/web-server.js";

const keys = generateKeyPairSync("ed25519");
const now = 1800000000000;
function signed(claims: unknown, privateKey = keys.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(claims));
  return `${bytes.toString("base64url")}.${sign(null, bytes, privateKey).toString("base64url")}`;
}
const claims = { v: 1, iat: now / 1000 - 1, exp: now / 1000 + 60, user: "human:fixture", cap: "CA" };
const token = signed(claims);
const principal = { kind: "human" as const, identity: "homeauth:human:fixture" };
const accept = (p: RequestPrincipal = principal): RequestAuthenticator => ({ authenticate: () => p });
afterEach(() => vi.unstubAllEnvs());

describe("request authenticator consensus", () => {
  it("requires acceptance, allows identical principals, rejects differing identities/kinds/permissions", () => {
    expect(authenticateMaterial([{ authenticate: () => undefined }], {})).toBeUndefined();
    expect(authenticateMaterial([accept()], {})).toEqual(principal);
    expect(authenticateMaterial([accept(), accept()], {})).toEqual(principal);
    for (const different of [{ kind: "human" as const, identity: "other" }, { kind: "node" as const, identity: principal.identity }]) {
      expect(() => authenticateMaterial([accept(), accept(different)], {})).toThrow("AUTHENTICATION_REJECTED");
      expect(() => authenticateMaterial([accept(different), accept()], {})).toThrow("AUTHENTICATION_REJECTED");
    }
    expect(() => authenticateMaterial([accept({ kind: "integration", identity: "a", permissions: [] }), accept({ kind: "integration", identity: "a", permissions: ["prompt.submit"] })], {})).toThrow();
  });
  it("a rejected dedicated admission cannot be rescued by another provider", () => {
    const homeauth = new HomeAuthAdmissionAuthenticator({ publicKey: keys.publicKey, serviceId: 3, now: () => now });
    expect(() => authenticateMaterial([accept(), homeauth], { admission: "malformed" })).toThrow("AUTHENTICATION_REJECTED");
    expect(() => authenticateMaterial([homeauth, accept()], { admission: signed({ ...claims, cap: "EA" }) })).toThrow("AUTHENTICATION_REJECTED");
  });
  it("errors veto acceptance regardless of ordering without leaking provider errors", () => {
    const broken = { authenticate() { throw new Error("secret-in-provider-error"); } };
    for (const chain of [[accept(), broken], [broken, accept()]]) expect(() => authenticateMaterial(chain, {})).toThrow("AUTHENTICATION_REJECTED");
  });
});

async function fixture(apiOnly = false, mode: "compatible" | "required" = "compatible", enabled = true, additional: readonly RequestAuthenticator[] = []) {
  const manager = new PluginManager();
  const plugin = createHomeAuthAdmissionPlugin(new HomeAuthAdmissionAuthenticator({ publicKey: keys.publicKey, serviceId: 3, now: () => now }));
  await manager.register([plugin]);
  const server = createPortaWebServer({ gateway: { async *execute() {} }, modelCatalog: async () => [], uiSessions: new Map([["fixture", now + 1e12]]), ...(enabled ? { requestAuthenticators: [...manager.resolveAll<RequestAuthenticator>({ capability: "auth.request-authentication", version: "1" }), ...additional] } : {}) }, { port: 0, apiOnly, apiAuthentication: mode });
  await server.listen();
  const address = server.server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return { base: `http://127.0.0.1:${address.port}`, async close() { await server.close(); await manager.stop([plugin]); } };
}
function duplicate(base: string, path: string, headers: string[]): Promise<number> {
  return new Promise((resolve, reject) => { const req = httpRequest(`${base}${path}`, { headers: ["Host", new URL(base).host, ...headers] }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end(); });
}

describe("production-like HomeAuth transport boundaries", () => {
  it("verifies a dedicated signed header and exposes only the protected application", async () => {
    const f = await fixture();
    try {
      const res = await fetch(`${f.base}/api/models`, { headers: { "HomeAuth-Admission": token } });
      expect(res.status).toBe(200);
      expect((await fetch(`${f.base}/api/models`, { headers: { authorization: `Bearer ${token}`, "HomeAuth-Admission": token } })).status).toBe(200);
      expect((await fetch(`${f.base}/api/models`)).status).toBe(401);
    } finally { await f.close(); }
  });
  it("rejects malformed, expired, future, missing/wrong grants, wrong signature and unknown identity kinds", async () => {
    const f = await fixture();
    try {
      const bad = ["garbage", token + ".extra", "", "x".repeat(33000), signed({ ...claims, exp: now / 1000 }), signed({ ...claims, iat: now / 1000 + 31 }), signed({ ...claims, cap: "EA" }), signed({ ...claims, cap: "" }), signed({ ...claims, cap: undefined }), signed({ ...claims, user: "admin:evil" }), signed({ ...claims, user: "bare-identity" }), signed(claims, generateKeyPairSync("ed25519").privateKey), signed({ ...claims, v: 2 })];
      for (const admission of bad) {
        const res = await fetch(`${f.base}/api/models`, { headers: { "HomeAuth-Admission": admission, cookie: "porta_ui=fixture" } });
        expect([401, 431]).toContain(res.status);
      }
    } finally { await f.close(); }
  });
  it("rejects identity spoofing, duplicate headers and credential conflicts even with a valid cookie/token", async () => {
    const f = await fixture();
    try {
      for (const name of ["X-HomeAuth-Subject", "X-HomeAuth-Kind", "Remote-User"]) expect((await fetch(`${f.base}/api/models`, { headers: { [name]: "evil", "HomeAuth-Admission": token } })).status).toBe(401);
      for (const name of ["Authorization", "HomeAuth-Admission", "Cookie"]) {
        const value = name === "Authorization" ? `Bearer ${token}` : name === "Cookie" ? "porta_ui=fixture" : token;
        expect(await duplicate(f.base, "/api/models", [name, value, name.toLowerCase(), value])).toBe(401);
      }
      const conflicts: Record<string, string>[] = [
        { authorization: "Bearer invalid", "HomeAuth-Admission": token },
        { authorization: `Bearer ${signed({ ...claims, user: "human:other" })}`, "HomeAuth-Admission": token },
        { cookie: "porta_ui=fixture", "HomeAuth-Admission": token },
        { cookie: "porta_ui=fixture", authorization: "Bearer invalid" },
      ];
      for (const headers of conflicts) expect((await fetch(`${f.base}/api/models`, { headers })).status).toBe(401);
    } finally { await f.close(); }
  });
  it("applies order-independent authenticator consensus through the HTTP boundary", async () => {
    const same = accept();
    const f = await fixture(false, "compatible", true, [same]);
    try {
      expect((await fetch(`${f.base}/api/models`, { headers: { "HomeAuth-Admission": token } })).status).toBe(200);
    } finally { await f.close(); }
    for (const conflicting of [accept({ kind: "human", identity: "another-human" }), { authenticate() { throw new Error("sensitive provider failure"); } }]) {
      const server = await fixture(false, "compatible", true, [conflicting]);
      try { expect((await fetch(`${server.base}/api/models`, { headers: { "HomeAuth-Admission": token } })).status).toBe(401); }
      finally { await server.close(); }
    }
  });
  it("keeps the legacy backend API bearer in compatibility mode, but never as fallback for bad admission", async () => {
    vi.stubEnv("PORTA_LLM_API_SECRET", "local-fixture-secret");
    for (const mode of ["compatible", "required"] as const) {
      const f = await fixture(true, mode);
      try {
        const path = `${f.base}/v1/models`;
        expect((await fetch(path, { headers: { authorization: "Bearer local-fixture-secret" } })).status).toBe(mode === "compatible" ? 200 : 401);
        expect((await fetch(path, { headers: { "HomeAuth-Admission": token } })).status).toBe(200);
        expect((await fetch(path, { headers: { authorization: "Bearer local-fixture-secret", "HomeAuth-Admission": token } })).status).toBe(200);
        expect((await fetch(path, { headers: { authorization: "Bearer local-fixture-secret", "HomeAuth-Admission": "spoofed" } })).status).toBe(401);
        expect((await fetch(path, { headers: { authorization: "Bearer wrong", "HomeAuth-Admission": token } })).status).toBe(401);
        expect((await fetch(path)).status).toBe(401);
      } finally { await f.close(); }
    }
  });
  it("does not grant service-admitted identities human UI or node privileges", async () => {
    const f = await fixture();
    try {
      const headers = { "HomeAuth-Admission": signed({ ...claims, user: "service:bridge" }) };
      expect((await fetch(`${f.base}/app`, { headers, redirect: "manual" })).status).toBe(303);
      expect((await fetch(`${f.base}/api/sessions`, { headers })).status).toBe(403);
      const res = await fetch(`${f.base}/api/models`, { headers });
      expect(res.status).toBe(403);
    } finally { await f.close(); }
  });
  it("preserves disabled behavior and refuses required mode without a plugin", async () => {
    vi.stubEnv("PORTA_LLM_API_SECRET", "local-fixture-secret");
    const f = await fixture(true, "compatible", false);
    try {
      expect((await fetch(`${f.base}/v1/models`, { headers: { authorization: "Bearer local-fixture-secret", "HomeAuth-Admission": "ignored-when-disabled" } })).status).toBe(200);
      expect((await fetch(`${f.base}/v1/models`, { headers: { "HomeAuth-Admission": token } })).status).toBe(401);
    } finally { await f.close(); }
    expect(() => createPortaWebServer({ gateway: { async *execute() {} } }, { apiAuthentication: "required" })).toThrow();
  });
});
