import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebAuthnService } from "../src/webauthn.js";

const credential = { credentialId: "pending-id", publicKey: "public-key", counter: 0, createdAt: "2026-01-01T00:00:00.000Z", displayName: "Porta Production E2E" };
const config = { rpID: "porta.home.arpa", rpName: "Porta", origin: "https://porta.home.arpa" };

describe("WebAuthn enrollment approval", () => {
  it("keeps pending credentials out of authentication until owner approval", () => {
    const directory = mkdtempSync(join(tmpdir(), "porta-webauthn-"));
    try {
      writeFileSync(join(directory, "webauthn.json"), JSON.stringify({ userId: "user", credentials: [], pendingCredentials: [credential] }));
      const service = new WebAuthnService(directory, config);
      expect(service.hasCredentials()).toBe(false);
      expect(service.listPending()).toEqual([credential]);
      service.approvePending(credential.credentialId);
      expect(service.hasCredentials()).toBe(true);
      expect(service.listPending()).toEqual([]);
      expect(new WebAuthnService(directory, config).list()).toEqual([credential]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects and independently revokes an automation credential", () => {
    const directory = mkdtempSync(join(tmpdir(), "porta-webauthn-"));
    try {
      const humanCredential = { ...credential, credentialId: "human-id", displayName: "Human passkey" };
      writeFileSync(join(directory, "webauthn.json"), JSON.stringify({ userId: "user", credentials: [humanCredential, credential], pendingCredentials: [{ ...credential, credentialId: "other-id" }] }));
      const service = new WebAuthnService(directory, config);
      service.rejectPending("other-id");
      expect(service.listPending()).toEqual([]);
      service.remove(credential.credentialId);
      expect(service.list()).toEqual([humanCredential]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
