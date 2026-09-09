import { access, lstat, readFile } from "node:fs/promises";
import { constants, existsSync as fileExistsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import process from "node:process";
import { loadPortaConfig, formatConfigError, PortaConfig } from "./porta-config.js";

export type DoctorCheckStatus = "ok" | "warning" | "failed";
export interface DoctorCheck { id: string; required: boolean; status: DoctorCheckStatus; message: string }
export interface DoctorReport {
  ok: boolean;
  porta: { version: string; executable: string; source: string; packageRoot: string };
  runtime: { nodeVersion: string; nodeExecutable: string; supported: boolean; requirement: string };
  configuration: { source: string; path?: string; provider?: string; model?: string; baseUrl?: string };
  workspace: { root?: string; filesystem: "disabled" | "read-only" | "available"; mutation: boolean; execution: boolean };
  persistence: { enabled: boolean; backend?: string; path?: string };
  credentials: { available: boolean | null; store: string };
  web: { available: boolean; root: string };
  checks: DoctorCheck[];
}

const minimumNode = [22, 19, 0] as const;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface DoctorOptions { cwd?: string; executable?: string; nodeVersion?: string; packageRoot?: string; configPath?: string }

export async function collectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const root = options.packageRoot ?? packageRoot;
  const executable = options.executable ?? process.argv[1] ?? process.execPath;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [];
  const version = await packageVersion(root);
  const source = await installationSource(root, executable);
  const supported = satisfiesNode(nodeVersion);
  checks.push({ id: "node-version", required: true, status: supported ? "ok" : "failed", message: supported ? `Node ${nodeVersion} satisfies >= 22.19.0.` : `Node ${nodeVersion} does not satisfy >= 22.19.0.` });

  const configPath = options.configPath ?? findConfigPath(cwd);
  let config: PortaConfig | undefined;
  let configError: string | undefined;
  try { config = await loadPortaConfig(configPath ?? ""); }
  catch (error) { configError = formatConfigError(error); checks.push({ id: "configuration", required: true, status: "failed", message: configError }); }
  if (config) checks.push({ id: "configuration", required: true, status: "ok", message: "Configuration parsed successfully." });

  const workspaceRoot = config?.filesystem ? await resolvedPath(config.filesystem.root, cwd) : undefined;
  const filesystem = config?.filesystem ? workspaceRoot ? "read-only" as const : "disabled" as const : "disabled" as const;
  let filesystemStatus: DoctorCheckStatus = "ok";
  if (config?.filesystem && !workspaceRoot) filesystemStatus = "failed";
  else if (config?.filesystem) filesystemStatus = "ok";
  checks.push({ id: "filesystem", required: Boolean(config?.filesystem), status: filesystemStatus, message: workspaceRoot ? `Workspace is accessible at ${workspaceRoot}.` : config?.filesystem ? "Configured workspace is not accessible." : "Filesystem tools are disabled." });

  const webRoot = join(root, "web");
  const webAvailable = await exists(join(webRoot, "index.html"));
  checks.push({ id: "web-assets", required: true, status: webAvailable ? "ok" : "failed", message: webAvailable ? "Web UI assets are available." : "Web UI assets are missing from the installation." });
  const credentials = await credentialAvailability(config);
  checks.push({ id: "credentials", required: false, status: credentials.available === false ? "warning" : "ok", message: credentials.available === false ? "Credential store directory is not available; providers that need local credentials may require login." : "Credential store directory is accessible." });

  const persistencePath = config?.persistence ? resolve(workspaceRoot ?? cwd, config.persistence.path) : undefined;
  return {
    ok: checks.every((check) => !check.required || check.status !== "failed"),
    porta: { version, executable, source, packageRoot: root },
    runtime: { nodeVersion, nodeExecutable: process.execPath, supported, requirement: ">= 22.19.0" },
    configuration: { source: configPath ? "file" : "defaults/environment", ...(configPath ? { path: resolve(configPath) } : {}), ...(config ? { provider: config.model.provider, model: config.model.model, ...("baseUrl" in config.model ? { baseUrl: config.model.baseUrl } : {}) } : {}) },
    workspace: { ...(workspaceRoot ? { root: workspaceRoot } : {}), filesystem: workspaceRoot ? (config?.filesystem?.mutation?.enabled ? "available" : "read-only") : filesystem, mutation: Boolean(config?.filesystem?.mutation?.enabled), execution: Boolean(config?.execution?.enabled) },
    persistence: { enabled: Boolean(config?.persistence?.enabled), ...(config?.persistence?.enabled ? { backend: config.persistence.driver, path: persistencePath } : {}) },
    credentials,
    web: { available: webAvailable, root: webRoot },
    checks,
  };
}

export function renderDoctor(report: DoctorReport, verbose = false): string {
  const lines = ["Porta Doctor", "", "Porta", `  Version:          ${report.porta.version}`, `  Executable:       ${report.porta.executable}`, `  Source:            ${report.porta.source}`, "", "Runtime", `  Node:             ${report.runtime.nodeVersion}`, `  Executable:       ${report.runtime.nodeExecutable}`, `  Requirement:      ${report.runtime.requirement}`, `  Status:           ${report.runtime.supported ? "OK" : "FAILED"}`, "", "Configuration", `  Config:           ${report.configuration.path ?? report.configuration.source}`, `  Provider:         ${report.configuration.provider ?? "unavailable"}`, `  Model:            ${report.configuration.model ?? "unavailable"}`, "", "Workspace", `  Root:             ${report.workspace.root ?? "not configured"}`, `  Filesystem:       ${report.workspace.filesystem}`, `  Mutation:         ${report.workspace.mutation ? "enabled" : "disabled"}`, `  Execution:        ${report.workspace.execution ? "enabled" : "disabled"}`, "", "Persistence", `  Enabled:          ${report.persistence.enabled ? "yes" : "no"}`, `  Backend:          ${report.persistence.backend ?? "none"}`, "", `Overall: ${report.ok ? "OK" : "FAILED"}`];
  if (verbose) { lines.splice(lines.length - 1, 0, "", "Checks", ...report.checks.map((check) => `  ${check.status.toUpperCase().padEnd(7)} ${check.id}: ${check.message}`), `  Web assets:       ${report.web.root}`, `  Credential store: ${report.credentials.store}`); }
  return `${lines.join("\n")}\n`;
}

function satisfiesNode(value: string): boolean { const actual = value.split(".").slice(0, 3).map((part) => Number(part)); for (let index = 0; index < minimumNode.length; index++) { const wanted = minimumNode[index]!; const got = actual[index] ?? 0; if (got !== wanted) return got > wanted; } return true; }
function findConfigPath(cwd: string): string | undefined { if (process.env.PORTA_CONFIG ?? process.env.HARNESS_CONFIG) return process.env.PORTA_CONFIG ?? process.env.HARNESS_CONFIG; for (const candidate of ["porta.json", ".porta/config.json"]) { const path = join(cwd, candidate); if (fileExistsSync(path)) return path; } return undefined; }
async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch { return false; } }
async function resolvedPath(path: string, cwd: string): Promise<string | undefined> { const result = resolve(cwd, path); return await exists(result) ? result : undefined; }
async function packageVersion(root: string): Promise<string> { try { const value = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string }; return value.version ?? "unknown"; } catch { return "unknown"; } }
async function installationSource(root: string, executable: string): Promise<string> { try { const link = await lstat(executable); if (link.isSymbolicLink()) return "npm-link / symlink"; } catch { /* diagnostic only */ } if (await exists(join(root, ".git"))) return "development checkout"; return "package installation"; }
async function credentialAvailability(_config: PortaConfig | undefined): Promise<DoctorReport["credentials"]> { const directory = resolve(process.env.PORTA_AUTH_DIR ?? join(homedir(), ".porta", "auth")); return { available: await exists(directory), store: directory }; }

export async function runDoctor(args: readonly string[]): Promise<number> { const json = args.includes("--json"); const verbose = args.includes("--verbose"); const report = await collectDoctor(); process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report, verbose)); return report.ok ? 0 : 1; }
