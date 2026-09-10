const MAX_PROMPT_BYTES = 512 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DEFAULTS = { endpoint: "", token: "", defaultTarget: "" };

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) }; }
function validEndpoint(value) { try { const url = new URL(value); return (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") ? url.origin : undefined; } catch { return undefined; } }
function validateMessage(message) {
  if (!message || typeof message.type !== "string") throw new Error("INVALID_EXTENSION_MESSAGE");
  if (!["porta.listNodes", "porta.listModels", "porta.submitPrompt"].includes(message.type)) throw new Error("UNKNOWN_EXTENSION_ACTION");
  if (message.type !== "porta.listNodes" && (typeof message.nodeId !== "string" || !ID_PATTERN.test(message.nodeId))) throw new Error("INVALID_NODE_ID");
  if (message.type === "porta.listModels" || message.type === "porta.listNodes") return;
  if (typeof message.content !== "string" || new TextEncoder().encode(message.content).byteLength > MAX_PROMPT_BYTES || !message.content.trim()) throw new Error("INVALID_PROMPT");
  if (typeof message.idempotencyKey !== "string" || !ID_PATTERN.test(message.idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (message.requestedModel !== undefined && (!message.requestedModel || typeof message.requestedModel.provider !== "string" || typeof message.requestedModel.model !== "string" || !ID_PATTERN.test(message.requestedModel.provider) || !ID_PATTERN.test(message.requestedModel.model))) throw new Error("INVALID_MODEL");
}
async function portaRequest(message) {
  validateMessage(message); const config = await settings(); const endpoint = validEndpoint(config.endpoint); if (!endpoint || !config.token) throw new Error("PORTA_EXTENSION_NOT_CONFIGURED");
  let path; let init = { headers: { Accept: "application/json", Authorization: `Bearer ${config.token}` } };
  if (message.type === "porta.listNodes") path = "/api/nodes";
  else if (message.type === "porta.listModels") path = `/api/models?target=${encodeURIComponent(message.nodeId)}`;
  else { path = "/api/prompt/submit"; init = { ...init, method: "POST", headers: { ...init.headers, "Content-Type": "application/json" }, body: JSON.stringify({ content: message.content, targetNodeId: message.nodeId, idempotencyKey: message.idempotencyKey, ...(message.requestedModel ? { requestedModel: message.requestedModel } : {}), source: "chatgpt-browser-extension" }) }; }
  const response = await fetch(new URL(path, endpoint), init); let body = {}; try { body = await response.json(); } catch {} if (!response.ok) throw new Error(body.error?.message || body.error || `PORTA_REQUEST_FAILED_${response.status}`); return body;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { if (sender.tab && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(sender.tab.url || "")) { sendResponse({ ok: false, error: "UNTRUSTED_MESSAGE_SENDER" }); return false; } void portaRequest(message).then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "PORTA_REQUEST_FAILED" })); return true; });
