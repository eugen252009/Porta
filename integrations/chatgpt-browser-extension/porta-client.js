(() => {
  async function request(message) { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) throw new Error(response?.error || "Porta extension request failed."); return response.value; }
  window.PortaExtensionClient = {
    nodes: () => request({ type: "porta.listNodes" }),
    models: (nodeId) => request({ type: "porta.listModels", nodeId }),
    submit: (content, nodeId, idempotencyKey, requestedModel) => request({ type: "porta.submitPrompt", content, nodeId, idempotencyKey, ...(requestedModel ? { requestedModel } : {}) })
  };
})();
