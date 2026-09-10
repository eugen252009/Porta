(() => {
  const MARKER = "data-porta-control";
  const style = document.createElement("style");
  style.textContent = `.porta-extension-control{position:relative;display:inline-flex;z-index:20;margin:8px 0;font:12px system-ui;color:#d7f7f1}.porta-extension-control button{border:1px solid #5d7775;border-radius:6px;padding:5px 8px;color:inherit;background:#182321;cursor:pointer}.porta-extension-menu{position:absolute;top:32px;right:0;display:grid;min-width:190px;padding:5px;border:1px solid #5d7775;border-radius:7px;background:#182321;box-shadow:0 8px 25px #0008}.porta-extension-menu button{text-align:left;border:0;margin:1px;padding:7px;background:transparent}.porta-extension-menu button:hover{background:#263a36}.porta-extension-menu button:disabled{opacity:.5;cursor:default}.porta-extension-status{padding:6px 8px;color:#9db2ad;white-space:nowrap}`;
  document.documentElement.append(style);

  function text(node) { return (node.innerText || node.textContent || "").trim(); }
  function renderedToMarkdown(root) {
    const blocks = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,li,blockquote")];
    if (!blocks.length) return text(root);
    const output = []; for (const block of blocks) { if (block.closest("pre") && block.tagName !== "PRE") continue; const value = text(block); if (!value) continue; if (block.tagName === "PRE") output.push("```\n" + value + "\n```"); else if (/^H[1-6]$/.test(block.tagName)) output.push(`${"#".repeat(Number(block.tagName.slice(1)))} ${value}`); else if (block.tagName === "LI") output.push(`- ${value}`); else if (block.tagName === "BLOCKQUOTE") output.push(`> ${value}`); else output.push(value); } return output.join("\n\n").trim();
  }
  function findArtifacts() {
    const roots = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-testid*="conversation-turn"]')];
    return roots.filter((root) => root.getAttribute("data-message-author-role") === "assistant" || /assistant/i.test(root.getAttribute("data-message-author-role") || root.getAttribute("data-testid") || "")).map((root) => root.querySelector(".markdown, .prose") || root).filter((root) => text(root));
  }
  function setStatus(container, message) { container.querySelector(".porta-extension-status")?.remove(); if (!message) return; const status = document.createElement("span"); status.className = "porta-extension-status"; status.textContent = message; container.append(status); }
  async function showTargets(container, artifact) {
    const menu = document.createElement("div"); menu.className = "porta-extension-menu"; menu.textContent = "Loading nodes…"; container.append(menu);
    try {
      const result = await window.PortaExtensionClient.nodes(); menu.replaceChildren(); const nodes = result.nodes || []; if (!nodes.length) { menu.textContent = "No Porta nodes available"; return; }
      for (const node of nodes) { const option = document.createElement("button"); option.type = "button"; option.textContent = `${node.displayName || node.id}${node.available === false ? " — unavailable" : ""}`; option.disabled = node.available === false; option.onclick = async () => { menu.remove(); setStatus(container, "Sending…"); try { const content = renderedToMarkdown(artifact); if (!content) throw new Error("No Markdown content found in this assistant block."); const key = artifact.dataset.portaIdempotency || (artifact.dataset.portaIdempotency = crypto.randomUUID()); const accepted = await window.PortaExtensionClient.submit(content, node.id, key); setStatus(container, `✓ Sent to ${accepted.nodeId}`); } catch (error) { setStatus(container, error instanceof Error ? error.message : "Porta submission failed."); } }; menu.append(option); }
    } catch (error) { menu.textContent = error instanceof Error ? error.message : "Porta nodes unavailable."; }
  }
  function inject(artifact) {
    if (artifact.querySelector(`[${MARKER}]`)) return; const container = document.createElement("span"); container.className = "porta-extension-control"; container.setAttribute(MARKER, "true"); const button = document.createElement("button"); button.type = "button"; button.textContent = "Send to Porta ▾"; button.onclick = () => { container.querySelector(".porta-extension-menu")?.remove(); void showTargets(container, artifact); }; container.append(button); artifact.append(container);
  }
  function scan() { for (const artifact of findArtifacts()) inject(artifact); }
  const observer = new MutationObserver(scan); observer.observe(document.body, { childList: true, subtree: true }); scan();
})();
