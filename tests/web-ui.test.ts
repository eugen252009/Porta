import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "web/app.js"), "utf8");
const page = readFileSync(join(process.cwd(), "web/index.html"), "utf8");
const styles = readFileSync(join(process.cwd(), "web/styles.css"), "utf8");

describe("Porta greenfield web workspace", () => {
  it("uses sessions as the only primary navigation", () => {
    expect(page).toContain('id="session-tabs"');
    expect(page).not.toContain("session-list");
    expect(page).not.toContain("task-list");
    expect(app).toContain("state.sessions");
    expect(app).toContain("activeSessionId");
  });

  it("uses one guarded canonical creation flow", () => {
    expect(app).toContain("async function createSession(targetId, model)");
    expect(app).toContain("await createSession(targetId || \"local\", model || undefined)");
    expect(app).toContain("state.creatingSession");
    expect(app).toContain("sessionCreateError.hidden = false");
    expect(app).toContain("activeSessionId = id");
  });

  it("keeps target and model context on the active session", () => {
    expect(page).toContain('id="session-target"');
    expect(page).toContain('id="session-model"');
    expect(app).toContain("session.targetId");
    expect(app).toContain("session.model");
    expect(app).toContain("openNewSession(session.targetId, sessionModel.value)");
    expect(app).toContain('targetUrl(`/api/sessions/${encodeURIComponent(session.sessionId)}/messages`, session.targetId)');
  });

  it("exposes actionable attention and approval flows", () => {
    expect(page).toContain('id="attention-button"');
    expect(page).toContain('id="attention-popover"');
    expect(page).toContain('id="session-attention"');
    expect(app).toContain("attentionLabel");
    expect(app).toContain("activateSession(session.id)");
    expect(app).toContain('reason: "approval_required"');
    expect(app).toContain("resolveApproval");
  });

  it("uses supported session lifecycle APIs", () => {
    expect(page).toContain('id="stop-session"');
    expect(page).toContain('id="delete-session"');
    expect(app).toContain("/api/sessions/${encodeURIComponent(session.sessionId)}/cancel");
    expect(app).toContain("/api/sessions/${encodeURIComponent(session.sessionId)}");
    expect(app).toContain("Its history will be retained");
  });

  it("keeps authentication, settings, composer, and responsive layout", () => {
    expect(app).toContain("/auth/webauthn");
    expect(page).toContain('id="open-settings"');
    expect(page).toContain('id="settings-dialog"');
    expect(page).toContain('id="composer"');
    expect(styles).toContain("@media(max-width:760px)");
  });
});
