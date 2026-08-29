const messages = document.querySelector("#messages");
const input = document.querySelector("#input");
const form = document.querySelector("#composer");
const send = document.querySelector("#send");
const status = document.querySelector("#status");
const model = document.querySelector("#model");
let sessionId;
let running = false;

function addMessage(kind, text = "") {
  const element = document.createElement("article");
  element.className = `message ${kind}`;
  const label = document.createElement("div"); label.className = "label"; label.textContent = kind === "user" ? "You" : "Porta";
  const content = document.createElement("div"); content.className = "content"; content.textContent = text;
  element.append(label, content); messages.append(element); messages.querySelector(".empty")?.remove();
  return content;
}
function addSystem(text) { const element = document.createElement("div"); element.className = "muted"; element.textContent = text; messages.append(element); }
function addTool(event, result) {
  const row = document.createElement("div"); row.className = `tool${result?.error ? " error" : ""}`;
  const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = result?.error ? "×" : "·";
  const name = document.createElement("span"); name.textContent = event.toolId;
  row.append(dot, name); if (result?.error) { const error = document.createElement("span"); error.textContent = ` ${result.error.message}`; row.append(error); }
  messages.append(row);
}
function showApproval(event) {
  const box = document.createElement("div"); box.className = "approval";
  const title = document.createElement("div"); title.className = "approval-title"; title.textContent = `Approval required · ${event.toolId}`;
  const details = document.createElement("div"); details.className = "approval-input"; details.textContent = JSON.stringify(event.input, null, 2);
  const actions = document.createElement("div"); actions.className = "approval-actions";
  for (const [decision, text] of [["approve", "Approve"], ["deny", "Deny"]]) { const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.className = decision; button.onclick = () => resolveApproval(event.approvalId, decision, box); actions.append(button); }
  box.append(title, details, actions); messages.append(box); box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function resolveApproval(approvalId, decision, box) {
  box.querySelectorAll("button").forEach((button) => button.disabled = true);
  await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
  box.remove();
}
async function createSession(session) {
  const response = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session ? { sessionId: session } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? result.error ?? "Could not create session.");
  sessionId = result.sessionId; localStorage.setItem("porta-session", sessionId); return sessionId;
}
async function submit(text) {
  if (running) return; running = true; send.disabled = true; status.textContent = "Working…";
  addMessage("user", text); const assistant = addMessage("assistant");
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: text }) });
    if (!response.ok || !response.body) throw new Error("The server could not start the execution.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
    while (true) { const next = await reader.read(); if (next.done) break; buffer += next.value; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) if (line) handleEvent(JSON.parse(line), assistant); }
    if (buffer) handleEvent(JSON.parse(buffer), assistant);
  } catch (error) { addSystem(error instanceof Error ? error.message : "Request failed."); }
  running = false; send.disabled = false; status.textContent = "Ready"; input.focus();
}
function handleEvent(event, assistant) {
  if (event.type === "OutputDelta") assistant.textContent += event.text;
  else if (event.type === "ToolCompleted") addTool(event, event.result);
  else if (event.type === "ApprovalRequested") showApproval(event);
  else if (event.type === "ExecutionCompleted") status.textContent = "Ready";
  else if (event.type === "ExecutionCancelled") status.textContent = "Cancelled";
  else if (event.type === "Error") addSystem(event.error.message);
  messages.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
form.addEventListener("submit", (event) => { event.preventDefault(); const text = input.value.trim(); if (text) { input.value = ""; submit(text); } });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; });
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
(async () => { try { await createSession(localStorage.getItem("porta-session")); model.textContent = "local session"; } catch (error) { addSystem(error instanceof Error ? error.message : "Could not connect to Porta."); } })();
