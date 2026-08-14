import { ToolContext } from "./contracts.js";

export interface ContentReductionRequest { readonly content: string; readonly purpose: "summary"; readonly source?: { readonly kind: string; readonly path?: string }; readonly maxChars?: number }
export interface ContentReductionResult { readonly content: string; readonly sourceChars: number }
export interface ContentReducer { reduce(request: ContentReductionRequest, context: ToolContext): Promise<ContentReductionResult> }
