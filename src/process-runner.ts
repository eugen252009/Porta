import { spawn } from "node:child_process";
import { HarnessFailure, failure } from "./contracts.js";

export interface ProcessRunRequest { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly environment: Readonly<Record<string, string>>; readonly signal: AbortSignal; readonly deadline?: number; readonly maxStdoutBytes: number; readonly maxStderrBytes: number }
export interface ProcessRunResult { readonly exitCode?: number; readonly stdout: string; readonly stderr: string; readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean; readonly status: "completed" | "cancelled" | "timed-out" }
export interface ProcessRunner { run(request: ProcessRunRequest): Promise<ProcessRunResult> }

export class DirectArgvProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.signal.aborted) throw failure("CANCELLED", "Process was cancelled before it started.");
    if (request.deadline !== undefined && request.deadline <= Date.now()) throw failure("TIMEOUT", "Process deadline expired before it started.", true);
    let child: ReturnType<typeof spawn>; try { child = spawn(request.executable, [...request.args], { cwd: request.cwd, env: { ...request.environment }, shell: false, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { throw failure("RUNTIME_FAILED", "Process could not be started.", true, { cause: error instanceof Error ? error.message : "spawn failure" }); }
    const stdout = new BoundedCapture(request.maxStdoutBytes); const stderr = new BoundedCapture(request.maxStderrBytes); let cause: "cancelled" | "timed-out" | undefined; let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: "cancelled" | "timed-out") => { if (!cause) cause = reason; if (!settled) child.kill("SIGTERM"); };
    const onAbort = () => terminate("cancelled"); request.signal.addEventListener("abort", onAbort, { once: true }); if (request.deadline !== undefined) timer = setTimeout(() => terminate("timed-out"), Math.max(0, request.deadline - Date.now()));
    const result = await new Promise<{ code: number | null }>((resolve, reject) => { child.once("error", (error) => reject(failure("RUNTIME_FAILED", "Process could not be started.", true, { cause: error.message }))); child.once("close", (code) => resolve({ code })); child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk)); child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk)); });
    settled = true; request.signal.removeEventListener("abort", onAbort); if (timer) clearTimeout(timer); if (cause) return { status: cause, stdout: stdout.value(), stderr: stderr.value(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated }; return { status: "completed", exitCode: result.code ?? undefined, stdout: stdout.value(), stderr: stderr.value(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated };
  }
}
class BoundedCapture { private valueText = ""; truncated = false; constructor(private readonly max: number) {} append(chunk: Buffer) { const value = this.valueText + chunk.toString(); if (Buffer.byteLength(value) <= this.max) { this.valueText = value; return; } const half = Math.floor(this.max / 2); this.valueText = `${value.slice(0, half)}\n...[truncated]...\n${value.slice(-half)}`; this.truncated = true; } value() { return this.valueText; } }
export function processFailure(error: unknown): HarnessFailure { return error instanceof HarnessFailure ? error : failure("RUNTIME_FAILED", error instanceof Error ? error.message : "Process execution failed."); }
