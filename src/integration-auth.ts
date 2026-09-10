import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "./node-delegation.js";

export interface IntegrationCredentialMetadata { readonly id: string; readonly label: string; readonly permissions: readonly string[]; readonly enabled: boolean; readonly createdAt: string; readonly lastUsedAt?: string }
interface StoredCredential extends IntegrationCredentialMetadata { readonly tokenHash: string }
export interface CreatedIntegrationCredential { readonly id: string; readonly label: string; readonly permissions: readonly string[]; readonly token: string }

/** Revocable, scoped bearer credentials for non-human HTTP clients. Raw tokens are never persisted. */
export class IntegrationCredentialStore {
  private credentials: StoredCredential[];
  private readonly path: string;
  constructor(directory = ".porta") { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.path = join(directory, "integration-credentials.json"); this.credentials = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) as StoredCredential[] : []; }
  create(label: string, permissions: readonly string[]): CreatedIntegrationCredential { if (!label.trim() || !permissions.length) throw new Error("INTEGRATION_CREDENTIAL_INVALID"); const token = `porta_int_${randomBytes(32).toString("base64url")}`; const credential: StoredCredential = { id: `integration-${randomUUID()}`, label: label.trim(), permissions: [...new Set(permissions)], enabled: true, createdAt: new Date().toISOString(), tokenHash: this.hash(token) }; this.credentials = [...this.credentials, credential]; this.persist(); return { id: credential.id, label: credential.label, permissions: credential.permissions, token }; }
  list(): readonly IntegrationCredentialMetadata[] { return this.credentials.map(({ tokenHash: _tokenHash, ...metadata }) => metadata); }
  revoke(id: string): void { this.credentials = this.credentials.map((credential) => credential.id === id ? { ...credential, enabled: false } : credential); this.persist(); }
  authenticate(token: string): Principal | undefined { const hash = this.hash(token); const index = this.credentials.findIndex((credential) => credential.tokenHash === hash && credential.enabled); const credential = this.credentials[index]; if (!credential) return undefined; const updated = { ...credential, lastUsedAt: new Date().toISOString() }; this.credentials = this.credentials.map((entry, entryIndex) => entryIndex === index ? updated : entry); this.persist(); return { kind: "integration", identity: `integration:${credential.id}`, permissions: credential.permissions }; }
  allows(principal: Principal | undefined, permission: string): boolean { return principal?.kind === "integration" && principal.permissions.includes(permission); }
  private hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private persist(): void { writeFileSync(this.path, JSON.stringify(this.credentials, null, 2) + "\n", { mode: 0o600 }); }
}
