import { z } from "zod";
import { SandboxBinding } from "./contracts.js";

/** Provider-neutral binding for a trusted direct-argv process wrapper. */
export const processWrapperBindingKind = "process.wrapper/v1";
export const processWrapperPayloadSchema = z.object({ wrapperExecutable: z.string().min(1), argsPrefix: z.array(z.string()), cwdFlag: z.string().min(1).optional() });
export type ProcessWrapperPayload = z.infer<typeof processWrapperPayloadSchema>;
export interface ProcessWrapperBinding extends SandboxBinding { readonly kind: typeof processWrapperBindingKind; readonly payload: ProcessWrapperPayload }
