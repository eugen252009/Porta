#!/usr/bin/env node
// Opt-in integration: requires built Porta, Go, and the local HomeAuth source tree.
// Uses only fresh temporary keys/database and loopback listeners; never contacts NAS.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPortaWebServer } from '../dist/src/web-server.js';
import { createHomeAuthAdmissionPlugin, HomeAuthAdmissionAuthenticator, homeAuthPublicKey } from '../dist/src/adapters/auth-homeauth.js';
import { PluginManager } from '../dist/src/kernel.js';

const source = process.argv[2];
if (!source) throw new Error('Usage: npm run build && node tools/qualify-homeauth.mjs /path/to/homelab-auth');
const root = mkdtempSync(join(tmpdir(), 'porta-homeauth-qualification-'));
const children = [], servers = [], managers = [];
const report = {};
const sha = (value) => createHash('sha256').update(value).digest('hex');
function run(binary, args, options = {}) { return execFileSync(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function start(binary, args, env = {}) { const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] }); children.push(child); return child; }
async function wait(url) { for (let i = 0; i < 100; i++) { try { await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(500) }); return; } catch {} await new Promise(r => setTimeout(r, 50)); } throw new Error('Local process startup failed'); }
async function post(url, body, headers = {}) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.equal(r.status, 200, `Local endpoint ${new URL(url).pathname} rejected request`); return r.json(); }
async function porta(publicKey, apiOnly, mode = 'required') {
  const observed = [];
  const auth = new HomeAuthAdmissionAuthenticator({ publicKey, serviceId: 3 });
  const plugin = createHomeAuthAdmissionPlugin(auth);
  // Record digests/principals in memory only; no credential values enter the report.
  const original = auth.authenticate.bind(auth);
  auth.authenticate = (material) => { const principal = original(material); if (principal) observed.push({ digest: sha(material.admission ?? material.authorization.slice(7)), principal }); return principal; };
  const manager = new PluginManager(); await manager.register([plugin]); managers.push([manager, plugin]);
  const uiSessions = new Map([['porta-fixture', Date.now() + 3_600_000]]);
  const server = createPortaWebServer({ gateway: { async *execute() {} }, modelCatalog: async () => [], uiSessions, requestAuthenticators: manager.resolveAll({ capability: 'auth.request-authentication', version: '1' }) }, { port: 0, apiOnly, apiAuthentication: mode });
  await server.listen(); servers.push(server);
  return { base: `http://127.0.0.1:${server.server.address().port}`, observed };
}
try {
  const authorityBin = join(root, 'authority'), clientBin = join(root, 'client');
  run('go', ['build', '-o', authorityBin, './cmd/homeauth'], { cwd: resolve(source) });
  run('go', ['build', '-o', clientBin, './cmd/homeauth-client'], { cwd: resolve(source) });
  const authorityKeys = generateKeyPairSync('ed25519');
  const seed = authorityKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = authorityKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  writeFileSync(join(root, 'authority.key'), Buffer.concat([seed, pub]).toString('base64'), { mode: 0o600 });
  writeFileSync(join(root, 'authority.pub'), pub.toString('base64url'));
  const ui = await porta(homeAuthPublicKey(pub), false);
  const authorityPort = await port(), base = `http://127.0.0.1:${authorityPort}`;
  const config = join(root, 'homeauth.toml');
  writeFileSync(config, `listen = "127.0.0.1:${authorityPort}"\nissuer = "${base}"\nrp_id = "localhost"\norigin = "http://localhost:${authorityPort}"\ndatabase = "${join(root, 'homeauth.db')}"\nsigning_key = "${join(root, 'authority.key')}"\nmachine_token_ttl = "1m"\nchallenge_ttl = "30s"\n`);
  run(authorityBin, ['bootstrap', '--config', config, '--id', 'fixture', '--name', 'Local fixture']);
  const fixtureDb = new DatabaseSync(join(root, 'homeauth.db'));
  fixtureDb.prepare('INSERT INTO services(service_id,identity,name,created_at) VALUES(3,?,?,?)').run('service:porta-fixture', 'Porta fixture', Math.floor(Date.now()/1000));
  fixtureDb.close();
  const { appendFileSync } = await import('node:fs');
  appendFileSync(config, `\n[[routes]]\nhost = "127.0.0.1"\nidentity = "service:porta-fixture"\nupstream = "${ui.base}"\naudience = "https://porta.fixture"\nadapter = "admission"\n`);
  start(authorityBin, [config]); await wait(`${base}/healthz`);
  const machine = generateKeyPairSync('ed25519');
  const mpub = machine.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const registration = await post(`${base}/api/register/start`, { name: 'local bridge', public_key: mpub.toString('base64url') });
  await post(`${base}/api/register/finish`, { registration_id: registration.registration_id, signature: sign(null, Buffer.from(registration.challenge, 'base64url'), machine.privateKey).toString('base64url') });
  run(authorityBin, ['approve', '--config', config, '--registration', registration.registration_id, '--identity', 'service:fixture', '--audience', 'https://porta.fixture']);
  run(authorityBin, ['grant', '--config', config, '--identity', 'service:fixture', '--service-id', '3']);
  const q = await post(`${base}/api/auth/ed25519/challenge`, { fingerprint: sha(mpub), audience: 'https://porta.fixture' });
  const issued = Math.floor(Date.now() / 1000), expires = issued + 30;
  const proof = `HOMEAUTH-V1\npurpose=authentication\naud=https://porta.fixture\nchallenge=${q.nonce}\niat=${issued}\nexp=${expires}`;
  const jwt = await post(`${base}/api/auth/ed25519/verify`, { challenge_id: q.challenge_id, audience: 'https://porta.fixture', issued, expires, signature: sign(null, Buffer.from(proof), machine.privateKey).toString('base64url') });
  const admission = await post(`${base}/api/admission`, undefined, { authorization: `Bearer ${jwt.token}` });
  const payload = JSON.parse(Buffer.from(admission.token.split('.')[0], 'base64url'));
  assert.equal(payload.exp - payload.iat, 60); assert.equal(payload.user, 'service:fixture');
  report.machineAuthorityChallengeAndIssuance = 'PASS';
  const secret = randomBytes(32).toString('base64url');
  process.env.PORTA_LLM_API_SECRET = secret;
  writeFileSync(join(root, 'backend.secret'), secret, { mode: 0o600 });
  const api = await porta(homeAuthPublicKey(pub), true);
  const common = { HOMEAUTH_MODE: '', HOMEAUTH_PUBLIC_KEY: join(root, 'authority.pub'), HOMEAUTH_SERVICE_ID: '3', HOMEAUTH_FORWARD_ADMISSION: 'true', HOMEAUTH_BACKEND_SECRET_FILE: join(root, 'backend.secret') };
  async function sidecar(upstream, adapter) { const p = await port(); start(clientBin, [], { ...common, HOMEAUTH_LISTEN: `127.0.0.1:${p}`, HOMEAUTH_UPSTREAM: upstream, HOMEAUTH_ADAPTER: adapter }); const b = `http://127.0.0.1:${p}`; await wait(b); return b; }
  if (process.argv[3]) {
    const observations = [];
    const sink = createHTTPServer((req, res) => { observations.push({ backendBearer: req.headers.authorization === `Bearer ${secret}`, originalInAuthorization: req.headers.authorization === `Bearer ${admission.token}`, admissionHeader: req.headers['homeauth-admission'] ?? null, identityHeaders: ['x-homeauth-subject', 'x-homeauth-kind', 'remote-user'].some(h => req.headers[h] !== undefined) }); res.writeHead(204); res.end(); });
    await new Promise(r => sink.listen(0, '127.0.0.1', r));
    servers.push({ close: () => new Promise(r => sink.close(r)) });
    const p = await port();
    start(resolve(process.argv[3]), [], { ...common, HOMEAUTH_FORWARD_ADMISSION: 'false', HOMEAUTH_LISTEN: `127.0.0.1:${p}`, HOMEAUTH_UPSTREAM: `http://127.0.0.1:${sink.address().port}`, HOMEAUTH_ADAPTER: 'backend-bearer' });
    const legacyProxy = `http://127.0.0.1:${p}`; await wait(legacyProxy);
    assert.equal((await fetch(`${legacyProxy}/v1/models`, { headers: { authorization: `Bearer ${admission.token}`, 'X-HomeAuth-Subject': 'spoof' } })).status, 204);
    assert.deepEqual(observations.at(-1), { backendBearer: true, originalInAuthorization: false, admissionHeader: null, identityHeaders: false });
    await fetch(`${legacyProxy}/v1/models`, { headers: { authorization: `Bearer ${admission.token}`, 'HomeAuth-Admission': 'untrusted-marker' } });
    assert.equal(observations.at(-1).admissionHeader, 'untrusted-marker');
    report.exactProductionSidecarBinary = 'PASS: admission replaced by backend bearer, identity stripped; arbitrary dedicated header was previously preserved untrusted';
  }
  const proxy = await sidecar(api.base, 'backend-bearer');
  assert.equal((await fetch(`${proxy}/v1/models`, { headers: { authorization: `Bearer ${admission.token}` } })).status, 200);
  assert(api.observed.some(x => x.digest === sha(admission.token) && x.principal.identity === 'homeauth:service:fixture' && x.principal.kind === 'integration'));
  report.authoritySidecarPortaTokenUnchangedAndVerified = 'PASS';
  assert.equal((await fetch(`${api.base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } })).status, 401);
  assert.equal((await fetch(`${api.base}/v1/models`, { headers: { 'HomeAuth-Admission': admission.token } })).status, 200);
  report.requiredModeDoesNotRelyOnBackendBearer = 'PASS';
  for (const headers of [{ authorization: 'Bearer fake' }, { 'HomeAuth-Admission': admission.token }, { authorization: `Bearer ${admission.token}`, 'HomeAuth-Admission': admission.token }]) assert((await fetch(`${proxy}/v1/models`, { headers })).status >= 400);
  for (const headers of [{ 'X-HomeAuth-Subject': 'human:admin' }, { 'HomeAuth-Admission': 'spoofed', authorization: `Bearer ${secret}` }]) assert.equal((await fetch(`${api.base}/v1/models`, { headers })).status, 401);
  report.spoofedAndDirectBypassAttempts = 'PASS';
  // Exercise the deployed bridge binary, not only a handcrafted token client.
  const mseed = machine.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  writeFileSync(join(root, 'machine.key'), Buffer.concat([mseed, mpub]).toString('base64'), { mode: 0o600 });
  const bridgePort = await port();
  start(clientBin, [], { HOMEAUTH_MODE: 'bridge', HOMEAUTH_LISTEN: `127.0.0.1:${bridgePort}`, HOMEAUTH_UPSTREAM: proxy, HOMEAUTH_AUTHORITY: base, HOMEAUTH_AUDIENCE: 'https://porta.fixture', HOMEAUTH_IDENTITY_KEY: join(root, 'machine.key'), HOMEAUTH_FINGERPRINT: sha(mpub) });
  const bridge = `http://127.0.0.1:${bridgePort}`; await wait(bridge);
  assert.equal((await fetch(`${bridge}/v1/models`)).status, 200);
  report.realMachineBridgePath = 'PASS (bridge callers must remain network-isolated)';
  const nativeProxy = await sidecar(api.base, 'native');
  assert.equal((await fetch(`${nativeProxy}/v1/models`, { headers: { authorization: `Bearer ${admission.token}` } })).status, 200);
  assert(api.observed.some(x => x.digest === sha(admission.token) && x.principal.identity === 'homeauth:service:fixture'));
  report.noBackendBearerWithNativeAdmissionForwarding = 'PASS';
  const directBridgePort = await port();
  start(clientBin, [], { HOMEAUTH_MODE: 'bridge', HOMEAUTH_LISTEN: `127.0.0.1:${directBridgePort}`, HOMEAUTH_UPSTREAM: api.base, HOMEAUTH_AUTHORITY: base, HOMEAUTH_AUDIENCE: 'https://porta.fixture', HOMEAUTH_IDENTITY_KEY: join(root, 'machine.key'), HOMEAUTH_FINGERPRINT: sha(mpub) });
  const directBridge = `http://127.0.0.1:${directBridgePort}`; await wait(directBridge);
  assert.equal((await fetch(`${directBridge}/v1/models`)).status, 200);
  report.bridgeDirectToPortaWithoutVerifierSidecar = 'PASS';
  // Seed an authenticated browser-session fixture, not a simulated passkey ceremony.
  // The real authority subsequently validates the cookie and issues the token.
  const cookie = randomBytes(32), db = new DatabaseSync(join(root, 'homeauth.db'));
  db.prepare('INSERT INTO browser_sessions VALUES(?,?,?,?)').run(sha(cookie), 'fixture', issued, issued + 3600);
  db.close();
  run(authorityBin, ['grant', '--config', config, '--identity', 'fixture', '--service-id', '3']);
  const human = await post(`${base}/api/admission`, undefined, { cookie: `homeauth_session=${cookie.toString('base64url')}` });
  report.authorityIssuesAdmissionFromSeededBrowserSession = 'PASS (seeded authority session; no passkey ceremony)';
  // Porta's browser listener keeps its own local session contract. A HomeAuth
  // admission forwarded for the machine API cannot replace that session.
  const portaCookie = { cookie: 'porta_ui=porta-fixture' };
  assert.equal((await fetch(`${ui.base}/app`, { headers: portaCookie })).status, 200);
  assert.equal((await fetch(`${ui.base}/api/models`, { headers: portaCookie })).status, 200);
  assert.equal((await fetch(`${ui.base}/app`, { headers: { ...portaCookie, 'HomeAuth-Admission': 'spoofed' } })).status, 200);
  assert.equal((await fetch(`${ui.base}/api/models`, { headers: { ...portaCookie, 'HomeAuth-Admission': human.token } })).status, 200);
  assert.equal((await fetch(`${ui.base}/app`, { headers: { 'HomeAuth-Admission': human.token }, redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${ui.base}/api/models`, { headers: { 'HomeAuth-Admission': human.token } })).status, 401);
  assert.equal(ui.observed.length, 0, 'the browser listener must not invoke machine/API authenticators');
  report.portaBrowserSessionAndAPISessionIsolation = 'PASS (seeded Porta session; no passkey ceremony; HomeAuth admission is not a browser login)';
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ...report, result: 'FAIL', failure: error instanceof assert.AssertionError ? error.message : `Local qualification failed (${error?.name}); no credentials logged` }, null, 2));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) { child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)); }
  for (const server of servers) await server.close();
  for (const [manager, plugin] of managers) await manager.stop([plugin]);
  rmSync(root, { recursive: true, force: true });
}
