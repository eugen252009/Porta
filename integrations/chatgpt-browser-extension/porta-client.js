(() => {
  const defaults = { endpoint: "", token: "", defaultTarget: "" };
  async function settings() { return { ...defaults, ...(await chrome.storage.local.get(defaults)) }; }
  async function request(path, options = {}) { const config = await settings(); if (!config.endpoint || !config.token) throw new Error("Configure the Porta endpoint and integration credential in extension settings."); const response = await fetch(new URL(path, config.endpoint), { ...options, headers: { Accept: "application/json", Authorization: `Bearer ${config.token}`, ...(options.headers || {}) } }); let body = {}; try { body = await response.json(); } catch {} if (!response.ok) throw new Error(body.error?.message || body.error || `Porta request failed (${response.status}).`); return body; }
  window.PortaExtensionClient = { settings, nodes: () => request("/api/nodes"), submit: (content, targetNodeId, idempotencyKey) => request("/api/prompt/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, targetNodeId, idempotencyKey, source: "chatgpt-browser-extension" }) }) };
})();
