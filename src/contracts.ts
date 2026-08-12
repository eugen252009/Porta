import { z } from "zod";

export const schemaVersion = z.literal(1);
export const id = z.string().regex(/^[a-z0-9][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
export const pluginId = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
export const capabilityId = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);

export const errorCodes = ["CAPABILITY_UNAVAILABLE", "CAPABILITY_CONFLICT", "PLUGIN_INVALID", "PLUGIN_DEPENDENCY_MISSING", "VALIDATION_FAILED", "AUTHORIZATION_DENIED", "POLICY_VIOLATION", "MODEL_FAILED", "TOOL_FAILED", "RUNTIME_FAILED", "SANDBOX_FAILED", "STORAGE_FAILED", "TIMEOUT", "CANCELLED", "INTERNAL_ERROR"] as const;
export type ErrorCode = (typeof errorCodes)[number];
export interface HarnessError { code: ErrorCode; message: string; retryable: boolean; source?: string; details?: unknown }
export const harnessErrorSchema = z.object({ code: z.enum(errorCodes), message: z.string(), retryable: z.boolean(), source: z.string().optional(), details: z.unknown().optional() });
export class HarnessFailure extends Error { constructor(readonly error: HarnessError) { super(error.message); } }
export const failure = (code: ErrorCode, message: string, retryable = false, details?: unknown) => new HarnessFailure({ code, message, retryable, details });

export interface CapabilityDescriptor { id: string; version: string; attributes?: Record<string, unknown> }
export interface CapabilityRequirement { capability: string; version?: string; optional?: boolean }
export const capabilityDescriptorSchema = z.object({ id: capabilityId, version: z.string().regex(/^\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?$/i), attributes: z.record(z.unknown()).optional() });
export const capabilityRequirementSchema = z.object({ capability: capabilityId, version: z.string().regex(/^\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?$/i).optional(), optional: z.boolean().optional() });
export const pluginManifestSchema = z.object({ schemaVersion: schemaVersion, id: pluginId, version: z.string().regex(/^\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?$/i), provides: z.array(capabilityDescriptorSchema), requires: z.array(capabilityRequirementSchema) });
export interface PluginManifest { schemaVersion: 1; id: string; version: string; provides: readonly CapabilityDescriptor[]; requires: readonly CapabilityRequirement[] }
export interface ComponentContext { readonly capabilities: CapabilityResolver }
export interface Initializable { initialize(context: ComponentContext): Promise<void> }
export interface Startable { start(): Promise<void> }
export interface Stoppable { stop(): Promise<void> }
export interface HealthCheckable { health(): Promise<HealthStatus> }
export const healthReasons = ["unreachable", "resource-unavailable", "invalid-response", "timeout", "provider-error", "configuration-invalid"] as const;
export type HealthReason = (typeof healthReasons)[number];
export interface HealthStatus { status: "healthy" | "unhealthy"; reason?: HealthReason; message?: string; details?: unknown }
export const healthStatusSchema = z.object({ status: z.enum(["healthy", "unhealthy"]), reason: z.enum(healthReasons).optional(), message: z.string().optional(), details: z.unknown().optional() });
export interface CapabilityResolver { resolve(requirement: CapabilityRequirement): CapabilityDescriptor | undefined }
export interface PluginRegistrar { provide(capability: CapabilityDescriptor, component: unknown): void }
export interface HarnessPlugin { readonly manifest: PluginManifest; register(registrar: PluginRegistrar): void | Promise<void>; initialize?: Initializable["initialize"]; start?: Startable["start"]; stop?: Stoppable["stop"] }

export interface ExecutionContext { readonly traceId: string; readonly sessionId: string; readonly executionId: string; readonly signal: AbortSignal; readonly deadline?: number }
export interface CommandContext { readonly signal?: AbortSignal; readonly deadline?: number; readonly traceId?: string }
export interface ModelDescriptor { readonly id: string; readonly version: string; readonly capabilities: readonly CapabilityDescriptor[] }
export interface ModelRequest { schemaVersion: 1; requestId: string; input: string }
export interface ModelContext extends ExecutionContext {}
export type ModelEvent = { type: "delta"; text: string } | { type: "completed" };
export interface ModelProvider { readonly descriptor: ModelDescriptor; generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> }
export interface ToolDescriptor { id: string; version: string; description?: string }
export interface ToolInvocation { schemaVersion: 1; requestId: string; toolId: string; input: unknown }
export interface ToolResult { ok: boolean; output?: unknown; error?: HarnessError }
export interface ToolContext extends ExecutionContext {}
export interface ToolProvider { listTools(context: ToolContext): Promise<readonly ToolDescriptor[]>; invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> }
export interface Storage { createSession(session: Session): Promise<void>; getSession(id: string): Promise<Session | undefined>; closeSession(id: string): Promise<void> }
export interface Session { schemaVersion: 1; id: string; state: "open" | "closed"; createdAt: string }
export interface InputMessage { schemaVersion: 1; type: "create-session" | "submit-input" | "cancel-execution" | "close-session"; sessionId?: string; input?: string }
export interface InputAdapter { input(): AsyncIterable<InputMessage> }
export interface PresentationEvent { schemaVersion: 1; event: KernelEvent }
export interface Renderer { render(event: PresentationEvent): Promise<void> }
export interface TelemetryEvent { schemaVersion: 1; name: string; attributes?: Record<string, string> }
export interface TelemetrySink { emit(event: TelemetryEvent): Promise<void> }
export type EnforcementLevel = "native" | "external" | "best-effort" | "unsupported";
export type ResourceAccess = "allow" | "deny" | "best-effort";
export interface ExecutionPolicy { filesystem: ResourceAccess; network: ResourceAccess; codeLoading?: ResourceAccess }
export const executionPolicySchema = z.object({ filesystem: z.enum(["allow", "deny", "best-effort"]), network: z.enum(["allow", "deny", "best-effort"]), codeLoading: z.enum(["allow", "deny", "best-effort"]).default("allow") });
export interface ExecutionRequest { schemaVersion: 1; source?: string; args?: readonly string[]; stdin?: string; workingDirectory?: string; environment?: Record<string, string>; timeoutMs?: number; policy: ExecutionPolicy }
export const executionRequestSchema = z.object({ schemaVersion, source: z.string().optional(), args: z.array(z.string()).optional(), stdin: z.string().optional(), workingDirectory: z.string().optional(), environment: z.record(z.string()).optional(), timeoutMs: z.number().int().positive().optional(), policy: executionPolicySchema });
export type RuntimeEvent = { type: "started"; executionId: string } | { type: "stdout"; data: string } | { type: "stderr"; data: string } | { type: "exited"; exitCode?: number } | { type: "completed" } | { type: "failed"; error: HarnessError } | { type: "cancelled" };
export type ExecutionResult = { executionId: string; status: "completed" | "failed" | "cancelled" | "timed-out"; exitCode?: number; output?: unknown; error?: HarnessError };
export interface RuntimeExecution { readonly id: string; events(): AsyncIterable<RuntimeEvent>; writeStdin?(data: Uint8Array): Promise<void>; cancel(reason?: string): Promise<void>; result(): Promise<ExecutionResult> }
export interface SandboxCapabilities { filesystem: EnforcementLevel; network: EnforcementLevel; codeLoading: EnforcementLevel }
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema)]));
export const bindingKind = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\/[vV]\d+$/);
export const sandboxBindingSchema = z.object({ schemaVersion: schemaVersion, kind: bindingKind, payload: jsonValueSchema });
export type SandboxBinding = z.infer<typeof sandboxBindingSchema>;
export interface SandboxSession { readonly id: string; readonly binding?: SandboxBinding; dispose(): Promise<void> }
export interface RuntimeHost { readonly descriptor: { id: string; version: string }; readonly supportedBindingKinds?: readonly string[]; createExecution(request: ExecutionRequest, context: ExecutionContext, sandbox: SandboxSession): Promise<RuntimeExecution> }
export interface SandboxProvider { readonly descriptor: { id: string; version: string }; readonly capabilities: SandboxCapabilities; create(policy: ExecutionPolicy): Promise<SandboxSession> }

export type KernelCommand = { type: "CreateSession" } | { type: "SubmitInput"; sessionId: string; input: string } | { type: "CancelExecution"; sessionId: string } | { type: "CloseSession"; sessionId: string };
export type KernelEvent = { type: "ExecutionStarted"; executionId: string } | { type: "OutputStarted" } | { type: "OutputDelta"; text: string } | { type: "OutputCompleted" } | { type: "Warning"; message: string } | { type: "Error"; error: HarnessError } | { type: "ExecutionCompleted" } | { type: "ExecutionCancelled" } | { type: "SessionCreated"; sessionId: string } | { type: "SessionClosed"; sessionId: string };
export const kernelEventSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("ExecutionStarted"), executionId: id }), z.object({ type: z.literal("OutputStarted") }), z.object({ type: z.literal("OutputDelta"), text: z.string() }), z.object({ type: z.literal("OutputCompleted") }), z.object({ type: z.literal("Warning"), message: z.string() }), z.object({ type: z.literal("Error"), error: harnessErrorSchema }), z.object({ type: z.literal("ExecutionCompleted") }), z.object({ type: z.literal("ExecutionCancelled") }), z.object({ type: z.literal("SessionCreated"), sessionId: id }), z.object({ type: z.literal("SessionClosed"), sessionId: id })]);
export interface ApplicationGateway { execute(command: KernelCommand, context: CommandContext): AsyncIterable<KernelEvent> }
