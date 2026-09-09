import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { InstanceIdentityStore, LoginService } from "../src/identity.js";
describe("Porta identity login", () => {
  it("persists identity and accepts one valid signed login", () => {
    const a = mkdtempSync(`${tmpdir()}/porta-a-`); const b = mkdtempSync(`${tmpdir()}/porta-b-`);
    try { const ai = new InstanceIdentityStore(a); const bi = new InstanceIdentityStore(b); expect(ai.public.identity).not.toBe(bi.public.identity); const again = new InstanceIdentityStore(a); expect(again.public).toEqual(ai.public); bi.allow(ai.public, "A"); const login = new LoginService(bi); const challenge = login.challenge(); const result = login.login({ challengeId: challenge.challengeId, identity: ai.public.identity, signature: ai.sign(challenge) }); expect(login.authenticateToken(result.token)).toBe(ai.public.identity); expect(() => login.login({ challengeId: challenge.challengeId, identity: ai.public.identity, signature: ai.sign(challenge) })).toThrow("LOGIN_CHALLENGE_UNKNOWN"); } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });
  it("rejects an identity whose public key does not match", () => { const a = mkdtempSync(`${tmpdir()}/porta-a-`); try { const ai = new InstanceIdentityStore(a); expect(() => ai.allow({ identity: "porta:ed25519:wrong", publicKey: ai.public.publicKey, algorithm: "ed25519" }, "wrong")).toThrow("IDENTITY_PUBLIC_KEY_MISMATCH"); } finally { rmSync(a, { recursive: true, force: true }); } });
  it("rejects an unallowed identity", () => { const a = mkdtempSync(`${tmpdir()}/porta-a-`); const b = mkdtempSync(`${tmpdir()}/porta-b-`); try { const ai = new InstanceIdentityStore(a); const bi = new InstanceIdentityStore(b); const login = new LoginService(bi); const c = login.challenge(); expect(() => login.login({ challengeId: c.challengeId, identity: ai.public.identity, signature: ai.sign(c) })).toThrow("SIGNATURE_INVALID"); } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); } });
});
