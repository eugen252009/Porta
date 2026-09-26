import type { IncomingMessage } from "node:http";
import type { AuthenticationMaterial, RequestAuthenticator, RequestPrincipal } from "./contracts.js";

export class AuthenticationRejected extends Error {
  constructor() { super("AUTHENTICATION_REJECTED"); }
}

/** Order-independent consensus: identical principals (including permissions) are allowed. */
export function authenticateMaterial(providers: readonly RequestAuthenticator[], material: AuthenticationMaterial): RequestPrincipal | undefined {
  const accepted: RequestPrincipal[] = [];
  let failed = false;
  for (const provider of providers) {
    try { const principal = provider.authenticate(material); if (principal) accepted.push(validatePrincipal(principal)); }
    catch { failed = true; }
  }
  if (failed) throw new AuthenticationRejected();
  return principalConsensus(accepted);
}

export function principalConsensus(principals: readonly RequestPrincipal[]): RequestPrincipal | undefined {
  const first = principals[0];
  if (!first) return undefined;
  const key = principalKey(first);
  if (principals.some((principal) => principalKey(principal) !== key)) throw new AuthenticationRejected();
  return first;
}

function validatePrincipal(principal: RequestPrincipal): RequestPrincipal {
  if (!principal || !["human", "node", "local", "integration"].includes(principal.kind) || typeof principal.identity !== "string" || !principal.identity || (principal.kind === "integration" && (!Array.isArray(principal.permissions) || !principal.permissions.every((p) => typeof p === "string")))) throw new AuthenticationRejected();
  return principal;
}
function principalKey(principal: RequestPrincipal): string {
  validatePrincipal(principal);
  return JSON.stringify([principal.kind, principal.identity, principal.kind === "integration" ? [...new Set(principal.permissions)].sort() : []]);
}

/** Inspect raw headers: Node normalizes/discards some duplicates before exposing headers. */
export function authenticationHeaders(request: IncomingMessage): AuthenticationMaterial {
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    if (["authorization", "homeauth-admission", "cookie"].includes(name)) {
      if (seen.has(name)) throw new AuthenticationRejected();
      seen.add(name);
    }
    if (["x-homeauth-subject", "x-homeauth-kind", "remote-user"].includes(name)) throw new AuthenticationRejected();
  }
  const authorization = request.headers.authorization;
  const admission = request.headers["homeauth-admission"];
  if (Array.isArray(admission) || (admission !== undefined && (!admission || admission.includes(","))) || (authorization !== undefined && (!authorization.startsWith("Bearer ") || authorization.includes(",") || !authorization.slice(7).trim()))) throw new AuthenticationRejected();
  const cookies = request.headers.cookie?.split(";").filter((part) => part.trim().startsWith("porta_ui=")) ?? [];
  if (cookies.length > 1) throw new AuthenticationRejected();
  return { ...(authorization !== undefined ? { authorization } : {}), ...(admission !== undefined ? { admission } : {}) };
}
