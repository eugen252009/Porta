const MAX_PROMPT_BYTES = 512 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DEFAULTS = { endpoint: "", token: "", defaultTarget: "" };

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) }; }
function validEndpoint(value) { try { const url = new URL(value); return (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") ? url.origin : undefined; } catch { return undefined; } }
function validText(value, max = 256) { return typeof value === "string" && value.length > 0 && value.length <= max; }
function validateMessage(message) {
  if (!message || typeof message.type !== "string") throw new Error("INVALID_EXTENSION_MESSAGE");
  if (!["porta.listNodes", "porta.listModels", "porta.submitPrompt"].includes(message.type)) throw new Error("UNKNOWN_EXTENSION_ACTION");
  if (message.type !== "porta.listNodes" && (typeof message.nodeId !== "string" || !ID_PATTERN.test(message.nodeId))) throw new Error("INVALID_NODE_ID");
  if (message.type === "porta.listModels" || message.type === "porta.listNodes") return;
  if (!validText(message.conversationId) || message.conversationId.length > 256) throw new Error("INVALID_CONVERSATION_ID");
  if (typeof message.content !== "string" || new TextEncoder().encode(message.content).byteLength > MAX_PROMPT_BYTES || !message.content.trim()) throw new Error("INVALID_PROMPT");
  if (typeof message.idempotencyKey !== "string" || !ID_PATTERN.test(message.idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (message.newSession !== undefined && typeof message.newSession !== "boolean") throw new Error("INVALID_NEW_SESSION");
  if (message.requestedModel !== undefined && (!message.requestedModel || typeof message.requestedModel.provider !== "string" || typeof message.requestedModel.model !== "string" || !ID_PATTERN.test(message.requestedModel.provider) || !ID_PATTERN.test(message.requestedModel.model))) throw new Error("INVALID_MODEL");
}
function mappingKey(endpoint, conversationId, nodeId) { return `${endpoint}|${conversationId}|${nodeId}`; }
async function portaRequest(message, sessionId) {
  validateMessage(message); const config = await settings(); const endpoint = validEndpoint(config.endpoint); if (!endpoint || !config.token) throw new Error("PORTA_EXTENSION_NOT_CONFIGURED");
  let path; let init = { headers: { Accept: "application/json", Authorization: `Bearer ${config.token}` } };
  if (message.type === "porta.listNodes") path = "/api/nodes";
  else if (message.type === "porta.listModels") path = `/api/models?target=${encodeURIComponent(message.nodeId)}`;
  else { path = "/api/prompt/submit"; init = { ...init, method: "POST", headers: { ...init.headers, "Content-Type": "application/json" }, body: JSON.stringify({ content: message.content, targetNodeId: message.nodeId, idempotencyKey: message.idempotencyKey, ...(sessionId ? { sessionId } : {}), ...(message.requestedModel ? { requestedModel: message.requestedModel } : {}), source: "chatgpt-browser-extension" }) }; }
  const response = await fetch(new URL(path, endpoint), init); let body = {}; try { body = await response.json(); } catch {} if (!response.ok) { const error = new Error(body.error?.message || body.error || `PORTA_REQUEST_FAILED_${response.status}`); error.code = body.kind || body.error?.code || `HTTP_${response.status}`; throw error; } return body;
}
async function submit(message) {
  const config = await settings(); const endpoint = validEndpoint(config.endpoint); if (!endpoint) throw new Error("PORTA_EXTENSION_NOT_CONFIGURED");
  const key = mappingKey(endpoint, message.conversationId, message.nodeId); const stored = await chrome.storage.local.get({ sessionMappings: {} }); const mappings = stored.sessionMappings || {};
  if (message.newSession) delete mappings[key];
  const sessionId = message.newSession ? undefined : mappings[key];
  const result = await portaRequest(message, sessionId);
  if (!validText(result.sessionId, 256)) throw new Error("PORTA_SESSION_ID_MISSING");
  mappings[key] = result.sessionId; await chrome.storage.local.set({ sessionMappings: mappings }); return { ...result, reused: Boolean(sessionId) };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { if (sender.tab && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(sender.tab.url || "")) { sendResponse({ ok: false, error: "UNTRUSTED_MESSAGE_SENDER" }); return false; } const operation = message?.type === "porta.submitPrompt" ? submit(message) : portaRequest(message); void operation.then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "PORTA_REQUEST_FAILED", code: error?.code })); return true; });
