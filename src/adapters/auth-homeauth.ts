import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { failure, type HarnessPlugin, type PluginRegistrar, type AuthenticationMaterial, type RequestAuthenticator, type RequestPrincipal } from "../contracts.js";

const capability = { id: "auth.request-authentication", version: "1" };
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const maxTokenBytes = 32 * 1024;
const maxUint64 = (1n << 64n) - 1n;

export interface HomeAuthAdmissionOptions {
  readonly publicKey: KeyObject;
  readonly serviceId: bigint | number;
  readonly now?: () => number;
}

interface AdmissionClaims {
  readonly v: number;
  readonly iat: number;
  readonly exp: number;
  readonly user: string;
  readonly cap: string;
}

/** Verifies HomeAuth's v1 Ed25519 admission token locally, including the service grant bit. */
export class HomeAuthAdmissionAuthenticator implements RequestAuthenticator {
  private readonly serviceId: bigint;
  private readonly now: () => number;

  constructor(private readonly options: HomeAuthAdmissionOptions) {
    const serviceId = typeof options.serviceId === "bigint" ? options.serviceId : Number.isSafeInteger(options.serviceId) ? BigInt(options.serviceId) : -1n;
    if (options.publicKey.type !== "public" || options.publicKey.asymmetricKeyType !== "ed25519") throw failure("VALIDATION_FAILED", "HomeAuth requires an Ed25519 public key.");
    if (serviceId < 0n || serviceId > maxUint64) throw failure("VALIDATION_FAILED", "HomeAuth service ID must be an unsigned 64-bit integer.");
    this.serviceId = serviceId;
    this.now = options.now ?? Date.now;
  }

  authenticate(request: AuthenticationMaterial): RequestPrincipal | undefined {
    const principal = this.verifyMaterial(request);
    // The dedicated channel is owned by this verifier: rejection cannot fall
    // through to another provider or a browser cookie.
    if (!principal && request.admission !== undefined) throw failure("AUTHORIZATION_DENIED", "HomeAuth admission rejected.");
    return principal;
  }

  private verifyMaterial(request: AuthenticationMaterial): RequestPrincipal | undefined {
    if (request.admission !== undefined && request.authorization !== undefined) return undefined;
    const header = request.authorization;
    if (request.admission === undefined && !header?.startsWith("Bearer ")) return undefined;
    const token = request.admission ?? header!.slice("Bearer ".length).trim();
    if (Buffer.byteLength(token) > maxTokenBytes) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const payloadBytes = decodeBase64Url(parts[0]!);
    const signature = decodeBase64Url(parts[1]!);
    if (!payloadBytes || !signature || signature.length !== 64) return undefined;
    try {
      if (!verify(null, payloadBytes, this.options.publicKey, signature)) return undefined;
      const claims = parseClaims(JSON.parse(payloadBytes.toString("utf8")) as unknown);
      if (!claims || !isWithinTimeWindow(claims, this.now())) return undefined;
      const grants = decodeBase64Url(claims.cap);
      if (!grants || !hasGrant(grants, this.serviceId)) return undefined;
      const kind = principalKind(claims.user);
      if (!kind) return undefined;
      // Admission is not delegation or application authorization.
      return kind === "human" ? { kind, identity: `homeauth:${claims.user}` } : { kind: "integration", identity: `homeauth:${claims.user}`, permissions: [] };
    } catch {
      return undefined;
    }
  }
}

export function homeAuthPublicKey(value: string | Uint8Array): KeyObject {
  if (typeof value === "string" && value.includes("-----BEGIN PUBLIC KEY-----")) {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw failure("VALIDATION_FAILED", "HomeAuth requires an Ed25519 public key.");
    return key;
  }
  const encoded = typeof value === "string" ? value.trim() : Buffer.from(value).toString("utf8").trim();
  const raw = typeof value === "string" ? decodeRawPublicKey(encoded) : Buffer.from(value);
  if (raw.length !== 32) throw failure("VALIDATION_FAILED", "HomeAuth public key must contain a 32-byte Ed25519 key.");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

export function createHomeAuthAdmissionPlugin(authenticator: HomeAuthAdmissionAuthenticator): HarnessPlugin {
  return {
    manifest: { schemaVersion: 1, id: "auth.homeauth-admission", version: "1", provides: [capability], requires: [] },
    register(registrar: PluginRegistrar) { registrar.provide(capability, authenticator); },
  };
}

function decodeRawPublicKey(value: string): Buffer {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") === value) return decoded;
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") === value) return decoded;
  }
  throw failure("VALIDATION_FAILED", "HomeAuth public key is not valid base64.");
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function parseClaims(value: unknown): AdmissionClaims | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const claims = value as Record<string, unknown>;
  if (claims.v !== 1 || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || typeof claims.user !== "string" || claims.user.length === 0 || typeof claims.cap !== "string") return undefined;
  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  if (expiresAt <= issuedAt || claims.user.length > 512 || claims.cap.length > maxTokenBytes) return undefined;
  return { v: 1, iat: issuedAt, exp: expiresAt, user: claims.user, cap: claims.cap };
}

function isWithinTimeWindow(claims: AdmissionClaims, nowMs: number): boolean {
  const nowSeconds = Math.floor(nowMs / 1000);
  return claims.iat <= nowSeconds + 30 && claims.exp > nowSeconds;
}

function hasGrant(capabilities: Uint8Array, serviceId: bigint): boolean {
  const byteIndex = serviceId / 8n;
  if (byteIndex >= BigInt(capabilities.length)) return false;
  return (capabilities[Number(byteIndex)]! & (1 << Number(serviceId % 8n))) !== 0;
}

function principalKind(user: string): "human" | "service" | "legacy" | undefined {
  const separator = user.indexOf(":");
  // A bare subject has no authenticated kind; never infer human privileges.
  if (separator <= 0 || separator === user.length - 1) return undefined;
  const kind = user.slice(0, separator);
  return kind === "human" || kind === "service" || kind === "legacy" ? kind : undefined;
}
