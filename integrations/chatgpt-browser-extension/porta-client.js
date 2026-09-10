(() => {
  async function request(message) { const response = await chrome.runtime.sendMessage(message); if (!response?.ok) { const error = new Error(response?.error || "Porta extension request failed."); error.code = response?.code; throw error; } return response.value; }
  window.PortaExtensionClient = {
    nodes: () => request({ type: "porta.listNodes" }),
    models: (nodeId) => request({ type: "porta.listModels", nodeId }),
    submit: (content, nodeId, idempotencyKey, conversationId, newSession = false, requestedModel) => request({ type: "porta.submitPrompt", content, nodeId, idempotencyKey, conversationId, newSession, ...(requestedModel ? { requestedModel } : {}) })
  };
})();
