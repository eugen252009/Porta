import { createHash, randomBytes } from "node:crypto";

export interface PairingPayload {
  readonly version: 1;
  readonly type: "porta-target-pairing";
  readonly targetId: string;
  readonly workspaceId: string;
  readonly endpoint: string;
  readonly identityFingerprint: string;
  readonly pairingToken: string;
  readonly expiresAt: string;
}

export class PairingSession {
  private readonly tokenHash: string;
  private consumed = false;
  constructor(readonly expiresAt: string = new Date(Date.now() + 5 * 60_000).toISOString(), token = randomBytes(32).toString("base64url")) { this.tokenHash = hash(token); this.secret = token; }
  readonly secret: string;
  consume(token: string): boolean { if (this.consumed || Date.now() >= Date.parse(this.expiresAt) || hash(token) !== this.tokenHash) return false; this.consumed = true; return true; }
  get expired(): boolean { return this.consumed || Date.now() >= Date.parse(this.expiresAt); }
}

export function pairingUrl(payload: PairingPayload, host = process.env.PORTA_PAIRING_HOST_URL ?? "http://localhost:4173"): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${host.replace(/\/$/, "")}/app#porta-target-pairing=${encoded}`;
}
export function pairingFingerprint(identity: string): string { return identity.replace(/^porta:ed25519:/, ""); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
