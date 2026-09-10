(() => {
  const MARKER = "data-porta-control";
  const COPY_BUTTON_SELECTOR = "button[aria-label]";
  const ARTIFACT_SELECTORS = "pre, [data-testid=code-block]";
  const ASSISTANT_SELECTORS = '[data-message-author-role="assistant"], [data-testid*="conversation-turn"]';
  const processedCopyActions = new WeakSet();
  const scopeTimers = new WeakMap();
  const style = document.createElement("style");
  style.textContent = `.porta-extension-control{position:relative;display:inline-flex;z-index:20;margin-inline-start:4px;font:12px system-ui;color:#d7f7f1;pointer-events:auto}.porta-extension-control button{border:1px solid #5d7775;border-radius:6px;padding:5px 8px;color:inherit;background:#182321;cursor:pointer}.porta-extension-control .porta-send-button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:8px;border:0;border-radius:9999px;color:inherit;background:transparent}.porta-extension-control .porta-send-button:hover{background:#0000000d}.porta-extension-control .porta-send-button svg{width:20px;height:20px}.porta-extension-menu{position:absolute;top:32px;right:0;display:grid;min-width:210px;padding:5px;border:1px solid #5d7775;border-radius:7px;background:#182321;box-shadow:0 8px 25px #0008}.porta-extension-menu button{text-align:left;border:0;margin:1px;padding:7px;background:transparent}.porta-extension-menu button:hover{background:#263a36}.porta-extension-menu button:disabled{opacity:.5;cursor:default}.porta-extension-status{padding:6px 8px;color:#9db2ad;white-space:nowrap}`;
  document.documentElement.append(style);

  function text(node) { return (node.textContent || "").trim(); }
  function isNativeCopyButton(button) { const label = button.getAttribute("aria-label")?.trim().toLocaleLowerCase(); return label === "copy" || label === "kopieren"; }
  function isOpenEditorButton(button) { const label = button.getAttribute("aria-label")?.trim().toLocaleLowerCase(); return label === "editor öffnen" || label === "open editor"; }
  function isAssistantCandidate(node) { return node instanceof Element && (node.matches('[data-message-author-role="assistant"]') || /assistant/i.test(node.getAttribute("data-message-author-role") || node.getAttribute("data-testid") || "")); }
  function assistantRoot(node) { const element = node instanceof Element ? node : node.parentElement; if (!element) return undefined; if (isAssistantCandidate(element)) return element; const closest = element.closest(ASSISTANT_SELECTORS); return closest && isAssistantCandidate(closest) ? closest : undefined; }
  function extensionOwned(node) { const element = node instanceof Element ? node : node.parentElement; return Boolean(element?.closest(`[${MARKER}]`)); }
  function artifactRoots(scope) { const roots = []; if (scope.matches?.(ARTIFACT_SELECTORS)) roots.push(scope); roots.push(...scope.querySelectorAll(ARTIFACT_SELECTORS)); return [...new Set(roots)].filter((root) => !extensionOwned(root)); }
  function findCodeArtifactForCopyButton(copyButton) {
    let ancestor = copyButton.parentElement;
    for (let depth = 0; ancestor && depth < 10; depth++, ancestor = ancestor.parentElement) { if (hasOpenEditorAction(ancestor)) { if (isAssistantCandidate(ancestor)) break; continue; } const roots = artifactRoots(ancestor).filter((root) => text(root)); if (roots.length === 1) return { type: "code", root: roots[0], source: roots[0] }; if (isAssistantCandidate(ancestor)) break; }
    return null;
  }
  function writingBlockHeaderFor(copyButton) { return copyButton.closest('[data-testid="writing-block-header-surface"]'); }
  function findWritingBlockArtifact(header) {
    const hasContent = (source) => source instanceof HTMLTextAreaElement ? Boolean(source.value.trim()) : Boolean(text(source));
    const sourceSelectors = ["textarea", "[contenteditable=true]", '[data-testid*="writing-block"]', "pre", "[data-testid=code-block]"];
    let ancestor = header.parentElement;
    for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
      for (const selector of sourceSelectors) { const sources = []; if (ancestor.matches?.(selector)) sources.push(ancestor); sources.push(...ancestor.querySelectorAll(selector)); const unique = [...new Set(sources)].filter((source) => source !== header && !header.contains(source) && !extensionOwned(source) && hasContent(source)); if (unique.length === 1) return { type: "writing-block", root: ancestor, header, source: unique[0] }; if (unique.length > 1) break; }
      if (isAssistantCandidate(ancestor)) break;
    }
    return null;
  }
  function findArtifactForCopyButton(copyButton) { const header = writingBlockHeaderFor(copyButton); if (header) return findWritingBlockArtifact(header); return findCodeArtifactForCopyButton(copyButton); }
  function actionButtons(scope) { const buttons = []; if (scope.matches?.(COPY_BUTTON_SELECTOR)) buttons.push(scope); buttons.push(...scope.querySelectorAll(COPY_BUTTON_SELECTOR)); return [...new Set(buttons)]; }
  function copyButtons(scope) { return actionButtons(scope).filter(isNativeCopyButton); }
  function hasOpenEditorAction(scope) { return actionButtons(scope).some(isOpenEditorButton); }
  function extractArtifactMarkdown(artifact) { if (artifact.type === "markdown-editor") { const source = artifact.source; const value = source instanceof HTMLTextAreaElement ? source.value : source.textContent; return value?.trim() || ""; } const code = artifact.source.matches("pre") ? artifact.source.querySelector("code") : artifact.source.querySelector("pre code, code"); return (code ? code.textContent : artifact.source.textContent)?.trim() || ""; }
  function conversationIdentity() { const match = location.pathname.match(/^\/c\/([^/]+)/); return match?.[1] || `temporary:${location.origin}${location.pathname}`; }
  function setStatus(container, message) { container.querySelector(".porta-extension-status")?.remove(); if (!message) return; const status = document.createElement("span"); status.className = "porta-extension-status"; status.textContent = message; container.append(status); }
  async function submitArtifact(container, artifact, node, newSession) {
    setStatus(container, newSession ? "Starting…" : "Sending…");
    try { const content = extractArtifactMarkdown(artifact); if (!content) throw new Error("No standalone artifact content found."); const key = newSession ? crypto.randomUUID() : artifact.root.dataset.portaIdempotency || (artifact.root.dataset.portaIdempotency = crypto.randomUUID()); const accepted = await window.PortaExtensionClient.submit(content, node.id, key, conversationIdentity(), newSession); setStatus(container, `✓ Sent to ${accepted.nodeId}${accepted.reused ? " (continued)" : ""}`); } catch (error) { setStatus(container, error instanceof Error ? error.message : "Porta submission failed."); }
  }
  async function showTargets(container, artifact) {
    const menu = document.createElement("div"); menu.className = "porta-extension-menu"; menu.textContent = "Loading nodes…"; container.append(menu);
    try { const result = await window.PortaExtensionClient.nodes(); menu.replaceChildren(); const nodes = result.nodes || []; if (!nodes.length) { menu.textContent = "No Porta nodes available"; return; }
      for (const node of nodes) { const option = document.createElement("button"); option.type = "button"; option.textContent = `${node.displayName || node.id}${node.available === false ? " — unavailable" : ""}`; option.disabled = node.available === false; option.onclick = () => { menu.remove(); void submitArtifact(container, artifact, node, false); }; menu.append(option); if (node.available !== false) { const fresh = document.createElement("button"); fresh.type = "button"; fresh.textContent = `${node.displayName || node.id} — New session`; fresh.onclick = () => { menu.remove(); void submitArtifact(container, artifact, node, true); }; menu.append(fresh); } }
    } catch (error) { menu.textContent = error instanceof Error ? error.message : "Porta nodes unavailable."; }
  }
  function inject(copyButton, artifact) {
    const actionContainer = copyButton.parentElement; if (!actionContainer || [...actionContainer.children].some((child) => child.matches?.(`[${MARKER}]`))) return;
    const container = document.createElement("span"); container.className = "porta-extension-control"; container.setAttribute(MARKER, "true"); const button = document.createElement("button"); button.type = "button"; button.className = "porta-send-button"; button.setAttribute(MARKER, "true"); button.setAttribute("aria-label", "Send to Porta"); button.title = "Send to Porta"; button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.236 22a3 3 0 0 0-2.2-5"/><path d="M16 20a3 3 0 0 1 3-3h1a2 2 0 0 0 2-2v-2a4 4 0 0 0-4-4V4"/><path d="M18 13h.01"/><path d="M18 6a4 4 0 0 0-4 4 7 7 0 0 0-7 7c0-5 4-5 4-10.5a4.5 4.5 0 1 0-9 0 2.5 2.5 0 0 0 5 0C7 10 3 11 3 17c0 2.8 2.2 5 5 5h10"/></svg>`; button.onclick = () => { container.querySelector(".porta-extension-menu")?.remove(); void showTargets(container, artifact); }; container.append(button); actionContainer.append(container);
  }
  function processScope(scope) { for (const copyButton of copyButtons(scope)) { if (processedCopyActions.has(copyButton) || extensionOwned(copyButton)) continue; const artifact = findArtifactForCopyButton(copyButton); if (!artifact) continue; inject(copyButton, artifact); processedCopyActions.add(copyButton); } }
  function queueScope(scope) { if (!scope || scopeTimers.has(scope)) return; scopeTimers.set(scope, setTimeout(() => { scopeTimers.delete(scope); processScope(scope); }, 650)); }
  function queueFromAddedNode(node) {
    if (!(node instanceof Element) || extensionOwned(node)) return;
    const root = assistantRoot(node); if (root) queueScope(root); else if (isNativeCopyButton(node)) queueScope(node); else if (node.querySelector(COPY_BUTTON_SELECTOR)) queueScope(node);
  }
  function initialDiscovery() { processScope(document); }
  const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) queueFromAddedNode(node); });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  initialDiscovery();
})();
