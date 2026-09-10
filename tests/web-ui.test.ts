import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "web/app.js"), "utf8");
const page = readFileSync(join(process.cwd(), "web/index.html"), "utf8");

describe("Porta web workspace UX", () => {
  it("keeps multiline drafts until an explicit submit", () => {
    expect(app).toContain('event.key === "Enter" && !event.shiftKey');
    expect(app).toContain("form.requestSubmit()");
    expect(app).toContain("input.value = \"\"; resizeInput(); submit(text)");
  });

  it("recovers stale sessions and keeps discussion clipboard-only", () => {
    expect(app).toContain('localStorage.removeItem(storageKey)');
    expect(app).toContain("navigator.clipboard");
    expect(app).toContain("discussionSnapshotText()");
    expect(app).toContain("discussionText.value = text");
    expect(app).not.toContain("discussionSessionId");
    expect(app).not.toContain("/api/sessions/${sessionId}/messages");
  });

  it("uses server-discovered models and keeps selection scoped to new sessions", () => {
    expect(app).toContain('targetUrl("/api/models")');
    expect(app).toContain('localStorage.setItem("porta-model", selectedModel)');
    expect(app).toContain("New sessions will use");
    expect(app).toContain("running = false; setStatus(executionStatus === \"working\" ? \"waiting\" : executionStatus)");
    expect(app).toContain("let currentSessionProvider;");
    expect(app).toContain("if (!valid(selectedModel)) selectedModel");
    expect(app).toContain("currentSessionModel = selectedModel");
    expect(app).toContain('createSession(undefined, "porta-session", { provider: selectedProvider, model: selectedModel })');
    expect(app).toContain("selectedProvider");
    expect(app).toContain("availableModelOptions");
    expect(app).toContain("nextOption.provider");
    expect(app).toContain("targetUrl(\"/api/models\")");
    expect(app).toContain("tab.selectedProvider");
    expect(app).toContain("delete-session");
    expect(app).toContain("loadTasks");
    expect(app).toContain("tab.selectedProvider");
    expect(app).toContain("model: selection");
    expect(app).not.toMatch(/apiKey|access_token|refresh_token/);
  });

  it("uses sessions as the primary navigation and exposes lifecycle seams", () => {
    expect(page).toContain('id="workspace-tabs"');
    expect(page).toContain('id="delete-session"');
    expect(page).not.toContain('id="session-list"');
    expect(page).not.toContain('id="task-list"');
    expect(app).toContain('/api/tasks');
    expect(app).toContain('/api/sessions/');
    expect(app).toContain('attentionSummary.addEventListener');
    expect(app).toContain('attentionLabel');
    expect(app).toContain('/api/node');
  });

  it("renders bounded, explicit quick actions only while waiting", () => {
    expect(page).toContain('id="quick-actions"');
    expect(page).toContain('id="discussion-fallback"');
    expect(app).toContain("return actions.slice(0, 2)");
    expect(app).toContain("button.onclick = () => submit(action.message)");
    expect(app).toContain("if (executionStatus !== \"waiting\" || running)");
  });
});
