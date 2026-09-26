import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

export interface GeneratedEd25519SshKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

export type GithubSshVerificationStatus = "verified" | "authentication-failed" | "network-error" | "host-key-failed" | "cancelled" | "unknown-error";

/** Generate an OpenSSH-compatible Ed25519 keypair; callers must keep privateKey server-side. */
export function generateEd25519SshKeyPair(comment = "porta-github"): GeneratedEd25519SshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length !== 44 || der.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") throw new Error("Ed25519 public key encoding is invalid.");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString("", der.subarray(12))]);
  const encoded = blob.toString("base64");
  const safeComment = comment.replace(/[^A-Za-z0-9._@+-]/g, "-").slice(0, 80) || "porta";
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: `ssh-ed25519 ${encoded} ${safeComment}`,
    fingerprint: fingerprintBlob(blob),
  };
}

export function sshKeyFingerprint(publicKey: string): string | undefined {
  const parts = publicKey.trim().split(/\s+/);
  const encoded = parts[1];
  if (!parts[0] || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || (encoded.includes("=") && encoded.length % 4 !== 0)) return undefined;
  const blob = Buffer.from(encoded, "base64");
  if (blob.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return undefined;
  const type = readSshString(blob, 0);
  if (!type || type.value.toString("utf8") !== parts[0] || type.next >= blob.length) return undefined;
  return fingerprintBlob(blob);
}

export function ed25519SshFingerprint(publicKey: string): string | undefined {
  const parts = publicKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519" || !parts[1]) return undefined;
  const fingerprint = sshKeyFingerprint(publicKey);
  if (!fingerprint) return undefined;
  const blob = Buffer.from(parts[1], "base64"); const type = readSshString(blob, 0); const key = type && readSshString(blob, type.next);
  return key?.value.length === 32 && key.next === blob.length ? fingerprint : undefined;
}

export function deriveEd25519SshPublicKey(privateKey: string, comment = "porta"):
  { readonly publicKey: string; readonly fingerprint: string } | undefined {
  try {
    const privateObject = createPrivateKey(privateKey);
    if (privateObject.asymmetricKeyType !== "ed25519") return undefined;
    const publicObject = createPublicKey(privateObject);
    const der = publicObject.export({ type: "spki", format: "der" });
    if (der.length !== 44 || der.subarray(0, 12).toString("hex") !== "302a300506032b6570032100") return undefined;
    const blob = Buffer.concat([sshString("ssh-ed25519"), sshString("", der.subarray(12))]);
    const safeComment = comment.replace(/[^A-Za-z0-9._@+-]/g, "-").slice(0, 80) || "porta";
    return { publicKey: `ssh-ed25519 ${blob.toString("base64")} ${safeComment}`, fingerprint: fingerprintBlob(blob) };
  } catch { return undefined; }
}

export function classifyGithubSshVerification(input: {
  readonly status: "completed" | "cancelled" | "timed-out";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}): GithubSshVerificationStatus {
  if (input.status === "cancelled") return "cancelled";
  if (input.status === "timed-out") return "network-error";
  const output = `${input.stderr}\n${input.stdout}`.toLowerCase();
  if (/host key verification failed|remote host identification has changed|no .* host key is known|offending .* key/.test(output)) return "host-key-failed";
  if (/could not resolve hostname|temporary failure in name resolution|name or service not known|network is unreachable|no route to host|connection timed out|operation timed out|connection refused|connection reset by peer/.test(output)) return "network-error";
  if (/permission denied \(publickey\)|too many authentication failures|sign_and_send_pubkey: signing failed/.test(output)) return "authentication-failed";
  if (/successfully authenticated/.test(output)) return "verified";
  return "unknown-error";
}

function sshString(value: string, bytes = Buffer.from(value, "utf8")): Buffer {
  const length = Buffer.allocUnsafe(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function readSshString(blob: Buffer, offset: number): { readonly value: Buffer; readonly next: number } | undefined {
  if (offset < 0 || offset + 4 > blob.length) return undefined;
  const length = blob.readUInt32BE(offset); const start = offset + 4; const next = start + length;
  if (next > blob.length) return undefined;
  return { value: blob.subarray(start, next), next };
}
function fingerprintBlob(blob: Buffer): string { return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`; }
