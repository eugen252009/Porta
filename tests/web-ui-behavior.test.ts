import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Execute the real controller, with deterministic API and DOM boundaries.
// Layout is qualified separately in a real browser.
const source = readFileSync("web/app.js", "utf8").replace(/^import .*\n/, "").split("(async () => { if (!await ensureAuth())")[0]!;
class Element {
  children: Element[] = [];
  hidden = false;
  textContent = "";
  innerHTML = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  dataset = {};
  style = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, (event: any) => unknown>();
  classList = { toggle() {} };
  replaceChildren(...children: Element[]) { this.children = children; }
  append(...children: Element[]) { this.children.push(...children); }
  addEventListener(type: string, handler: (event: any) => unknown) { this.listeners.set(type, handler); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  focus() {}
  reset() {}
}
function harness(sessions: Record<string, unknown>[] = [{ sessionId: "restored", status: "completed" }], fetcher?: (url: string, options?: Record<string, unknown>) => Promise<any>) {
  const elements = new Map<string, Element>();
  const requests: { url: string; options?: Record<string, unknown> }[] = [];
  const stored: string[] = [];
  const context = {
    document: {
      querySelector(id: string) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement() { return new Element(); },
    },
    localStorage: { setItem(_key: string, value: string) { stored.push(value); } },
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: async (url: string, options?: Record<string, unknown>) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, json: async () => ({ sessions }) }; },
  };
  runInNewContext(source, context);
  return { elements, requests, stored, run: (code: string) => runInNewContext(code, context) };
}

describe("workspace controller behavior", () => {
  it("renders recovered sessions without undefined activity and hides the welcome view", async () => {
    const ui = harness();
    await ui.run('state.nodes = [{id: "local"}]; loadSessions()');
    ui.run("renderSession()");
    expect(ui.elements.get("#empty-state")?.hidden).toBe(true);
    expect(ui.elements.get("#workspace")?.hidden).toBe(false);
    expect(ui.elements.get("#activity")?.children).toHaveLength(1);
    expect(ui.elements.get("#session-tabs")?.children[0]?.attributes["aria-current"]).toBe("true");
  });

  it("selects the most recently updated local session and prunes sessions confirmed closed by the API", async () => {
    const ui = harness([
      { sessionId: "older", target: "local", status: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { sessionId: "newest", target: "local", status: "ready", createdAt: "2026-01-02", updatedAt: "2026-01-03" },
    ]);
    ui.run('state.sessions.set("local:closed", {id: "local:closed", sessionId: "closed", targetId: "local", title: "Closed"});');
    await ui.run('state.nodes = [{id: "local"}]; loadSessions()');
    expect(ui.run("state.activeSessionId")).toBe("local:newest");
    expect(ui.run('state.sessions.has("local:closed")')).toBe(false);
    expect((ui.elements.get("#session-tabs")?.children[0] as any)?.dataset.sessionId).toBe("local:newest");
  });

  it("reveals assistant output a character at a time and drains the final text on completion", async () => {
    const ui = harness();
    ui.run('state.sessions.set("typing", {id: "typing", status: "working", activity: [{id: "assistant-typing", kind: "assistant", label: "Porta", text: "Streaming", streaming: true}], liveActivity: []}); renderActivity(state.sessions.get("typing"));');
    const content = () => ui.elements.get("#activity")?.children[0]?.children[1]?.textContent ?? "";
    expect(content()).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(content().length).toBeGreaterThan(0);
    expect(content().length).toBeLessThan("Streaming".length);
    ui.run('const item = state.sessions.get("typing").activity[0]; item.text += " response"; item.streaming = false; renderActivity(state.sessions.get("typing"));');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(content()).toBe("Streaming response");
  });

  it("continues typing across the durable job-to-history handoff", async () => {
    const ui = harness();
    ui.run('state.sessions.set("job-session", {id: "job-session", status: "running", activity: [], liveActivity: []}); applySnapshot(state.sessions.get("job-session"), {history: [], job: {id: "job-1", status: "running", historyBaseMessageCount: 0, activity: [{sequence: 1, kind: "assistant", text: "The answer is streaming."}]}}); renderActivity(state.sessions.get("job-session"));');
    const content = () => ui.elements.get("#activity")?.children[0]?.children[1]?.textContent ?? "";
    await new Promise((resolve) => setTimeout(resolve, 75));
    const beforeCommit = content();
    expect(beforeCommit.length).toBeGreaterThan(0);
    expect(beforeCommit.length).toBeLessThan("The answer is streaming.".length);
    ui.run('applySnapshot(state.sessions.get("job-session"), {history: [{role: "assistant", content: "The answer is streaming."}], job: {id: "job-1", status: "completed", historyBaseMessageCount: 0, activity: [{sequence: 1, kind: "assistant", text: "The answer is streaming."}]}}); renderActivity(state.sessions.get("job-session"));');
    expect(content()).toBe(beforeCommit);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(content()).toBe("The answer is streaming.");
  });

  it("hydrates new backend output, preserves approvals, and does not duplicate unchanged history", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: [{kind: "approval", approvalId: "p"}]});');
    const snapshot = '{status: "completed", history: [{role: "assistant", content: "Built successfully"}]}';
    ui.run(`applySnapshot(state.sessions.get("a"), ${snapshot})`);
    ui.run(`applySnapshot(state.sessions.get("a"), ${snapshot})`);
    expect(ui.run('state.sessions.get("a").activity.length')).toBe(2);
    expect(ui.run('state.sessions.get("a").activity[0].text')).toBe("Built successfully");
    expect(ui.run('state.sessions.get("a").status')).toBe("completed");
  });

  it("updates one live assistant projection from successive real job deltas", () => {
    const ui = harness(); ui.run('state.sessions.set("a", {activity: [{kind: "user", text: "hey", optimistic: true}]});');
    ui.run('applySnapshot(state.sessions.get("a"), {history: [], job: {id: "stream-1", status: "running", activity: [{kind: "user", text: "hey"}, {kind: "assistant", text: "Hel"}]}});');
    expect(ui.run('state.sessions.get("a").liveActivity.filter(x => x.kind === "assistant").length')).toBe(1);
    ui.run('applySnapshot(state.sessions.get("a"), {history: [], job: {id: "stream-1", status: "running", activity: [{kind: "user", text: "hey"}, {kind: "assistant", text: "Hello"}]}});');
    expect(ui.run('state.sessions.get("a").liveActivity.filter(x => x.kind === "assistant").map(x => x.text)')).toEqual(["Hello"]);
    ui.run('applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "hey"}, {role: "assistant", content: "Hello"}], job: {id: "stream-1", status: "completed", activity: [{kind: "user", text: "hey"}, {kind: "assistant", text: "Hello"}]}});');
    expect(ui.run('state.sessions.get("a").liveActivity')).toEqual([]);
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["hey", "Hello"]);
  });

  it("does not clobber streaming activity or fail on malformed history", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: [{kind: "assistant", text: "Streaming"}]}); state.running = true;');
    ui.run('applySnapshot(state.sessions.get("a"), {history: []})');
    expect(ui.run('state.sessions.get("a").activity[0].text')).toBe("Streaming");
    ui.run('state.running = false; applySnapshot(state.sessions.get("a"), {history: "invalid"})');
    expect(ui.run('state.sessions.get("a").activity[0].text')).toBe("Streaming");
  });

  it("uses durable job activity even when task status and conversation history are stale", async () => {
    const ui = harness(); await ui.run('state.nodes = [{id: "local"}]; loadSessions()');
    ui.run('activeSession().task = {status: "failed"}; applySnapshot(activeSession(), {status: "ready", history: [], job: {id: "j", status: "running", activity: [{kind: "user", text: "Build this"}, {kind: "assistant", text: "Working on the fixture"}]}}); renderSession()');
    expect(ui.elements.get("#session-status")?.textContent).toBe("Running");
    expect(ui.run('activeSession().liveActivity[1].text')).toBe("Working on the fixture");
    expect(ui.elements.get("#empty-state")?.hidden).toBe(true);
    expect(ui.elements.get("#activity")?.children).toHaveLength(2);
  });

  it("keeps canonical history visible while a live job projection is appended", async () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: []}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "MESSAGE_A_7F31"}, {role: "assistant", content: "RESPONSE_A"}], job: {id: "job-b", status: "running", activity: [{kind: "user", text: "MESSAGE_B_91C2"}, {kind: "assistant", text: "RESPONSE_B"}]}});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["MESSAGE_A_7F31", "RESPONSE_A"]);
    expect(ui.run('state.sessions.get("a").liveActivity.map(x => x.text)')).toEqual(["MESSAGE_B_91C2", "RESPONSE_B"]);
    ui.run('renderActivity(state.sessions.get("a"))');
    expect(ui.elements.get("#activity")?.children).toHaveLength(4);
  });

  it("suppresses the accepted job's live user projection beside the optimistic user", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {historySignature: JSON.stringify([{role: "user", content: "old"}, {role: "assistant", content: "done"}]), activity: [{kind: "user", text: "hey", optimistic: true}, {kind: "assistant", text: ""}]}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "old"}, {role: "assistant", content: "done"}], job: {id: "job-live", status: "running", historyBaseMessageCount: 2, activity: [{kind: "user", text: "hey"}, {kind: "assistant", text: "Thinking"}]}});');
    expect(ui.run('state.sessions.get("a").liveActivity.map(x => x.text)')).toEqual(["Thinking"]);
    ui.run('renderActivity(state.sessions.get("a"))');
    expect(ui.elements.get("#activity")?.children).toHaveLength(3);
  });

  it("does not duplicate a committed job after hydration", async () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: []}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "MESSAGE_A_7F31"}, {role: "assistant", content: "RESPONSE_A"}, {role: "user", content: "MESSAGE_B_91C2"}, {role: "assistant", content: "RESPONSE_B"}], job: {id: "job-b", status: "completed", historyBaseMessageCount: 2, activity: [{kind: "user", text: "MESSAGE_B_91C2"}, {kind: "assistant", text: "RESPONSE_B"}]}});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["MESSAGE_A_7F31", "RESPONSE_A", "MESSAGE_B_91C2", "RESPONSE_B"]);
    expect(ui.run('state.sessions.get("a").liveActivity')).toEqual([]);
  });

  it("keeps intentionally repeated identical submissions as two canonical entries", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: []}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "hey"}, {role: "user", content: "hey"}], job: {id: "job-2", status: "running", historyBaseMessageCount: 1, activity: [{kind: "user", text: "hey"}]}});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["hey", "hey"]);
    expect(ui.run('state.sessions.get("a").liveActivity')).toEqual([]);
  });

  it("reconciles the optimistic user entry with the active canonical job by turn position", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: []}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "same text"}], job: {id: "job-a", status: "running", historyBaseMessageCount: 0, activity: [{kind: "user", text: "same text"}, {kind: "assistant", text: "Thinking"}]}});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["same text"]);
    expect(ui.run('state.sessions.get("a").liveActivity.map(x => x.text)')).toEqual(["Thinking"]);
    ui.run('applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "same text"}, {role: "assistant", content: "done"}], job: {id: "job-a", status: "completed", historyBaseMessageCount: 0, activity: [{kind: "user", text: "same text"}, {kind: "assistant", text: "done"}]}});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["same text", "done"]);
    expect(ui.run('state.sessions.get("a").liveActivity')).toEqual([]);
  });

  it("keeps interrupted tasks failed when the history endpoint reports ready", async () => {
    const ui = harness();
    await ui.run('state.nodes = [{id: "local"}]; loadSessions()');
    ui.run('activeSession().task = {status: "failed", failureReason: "execution_interrupted"}; applySnapshot(activeSession(), {status: "ready", history: []}); renderSession()');
    expect(ui.elements.get("#session-status")?.textContent).toBe("Failed");
    const activity = ui.elements.get("#activity")!;
    expect(activity.children).toHaveLength(1);
    expect(activity.children[0]?.textContent).toContain("Execution was interrupted");
    expect(activity.children[0]?.textContent).toContain("has not been restarted automatically");
    expect(activity.children[0]?.attributes.role).toBe("alert");
    ui.run('applySnapshot(activeSession(), {status: "ready", history: []}); renderSession()');
    expect(activity.children).toHaveLength(1);
    expect(ui.elements.get("#session-status")?.textContent).toBe("Failed");
  });

  it("does not overwrite an active task with empty committed history", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {task: {status: "active"}, activity: []}); applySnapshot(state.sessions.get("a"), {status: "ready", history: []})');
    expect(ui.run('state.sessions.get("a").status')).toBe("active");
    expect(ui.run('taskFailureMessage({status: "failed", failureReason: "Tool unavailable"})')).toBe("Task failed: Tool unavailable");
    expect(ui.run('taskFailureMessage({status: "completed"})')).toBeUndefined();
  });

  it("keeps two session projections isolated", () => {
    const ui = harness();
    ui.run('state.sessions.set("a", {activity: []}); state.sessions.set("b", {activity: []}); applySnapshot(state.sessions.get("a"), {history: [{role: "user", content: "ALPHA_ONLY_7A91"}]}); applySnapshot(state.sessions.get("b"), {history: [{role: "user", content: "BETA_ONLY_C431"}]});');
    expect(ui.run('state.sessions.get("a").activity.map(x => x.text)')).toEqual(["ALPHA_ONLY_7A91"]);
    expect(ui.run('state.sessions.get("b").activity.map(x => x.text)')).toEqual(["BETA_ONLY_C431"]);
  });

  it("preserves reading position rather than snapping to the newest output", () => {
    const ui = harness();
    const activity = ui.elements.get("#activity")!;
    activity.scrollTop = 100;
    ui.run('renderActivity({activity: [{kind: "assistant", text: "Hello"}]})');
    expect(activity.scrollTop).toBe(100);
    activity.scrollTop = 600;
    ui.run('renderActivity({activity: [{kind: "assistant", text: "More output"}]})');
    expect(activity.scrollTop).toBe(1000);
  });

  it("creates and lists an SSH credential without retaining or rendering secret values", async () => {
    const privateKey = "PRIVATE_KEY_TEST_DO_NOT_DISPLAY";
    const knownHosts = "KNOWN_HOSTS_TEST_DO_NOT_DISPLAY";
    const ui = harness([], async (url, options) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ credential: { id: "credential-1", name: "homelab-nas", type: "ssh", scope: "global", createdAt: "2026-09-21T00:00:00.000Z" } }) };
      return { ok: true, json: async () => ({ credentials: [{ id: "credential-1", name: "homelab-nas", type: "ssh", scope: "global", createdAt: "2026-09-21T00:00:00.000Z" }] }) };
    });
    ui.run(`$("#global-git-name").value = "homelab-nas"; globalGitType.value = "ssh"; $("#global-ssh-key").value = ${JSON.stringify(privateKey)}; $("#global-known-hosts").value = ${JSON.stringify(knownHosts)}; $("#global-ssh-username").value = "eugen"; $("#global-ssh-config").value = "Port 22"; globalGitType.onchange()`);
    await ui.elements.get("#global-git-credential-form")!.listeners.get("submit")!({ preventDefault() {} });
    const post = ui.requests.find((request) => request.url === "/api/git-credentials" && request.options?.method === "POST");
    const payload = JSON.parse(String(post?.options?.body));
    expect(payload).toMatchObject({ name: "homelab-nas", type: "ssh", privateKey, knownHosts, sshConfig: "User eugen\nPort 22" });
    expect(ui.elements.get("#global-ssh-key")?.value).toBe("");
    expect(ui.elements.get("#global-known-hosts")?.value).toBe("");
    const treeText = (element: Element): string => `${element.textContent}${element.children.map(treeText).join("")}`;
    expect(treeText(ui.elements.get("#git-credential-list")!)).toContain("homelab-nas");
    expect(treeText(ui.elements.get("#git-credential-list")!)).toContain("Configured");
    expect(treeText(ui.elements.get("#git-credential-list")!)).not.toContain(privateKey);
    expect(treeText(ui.elements.get("#git-credential-list")!)).not.toContain(knownHosts);
    expect(ui.stored.join(" ")).not.toContain(privateKey);
    expect(ui.stored.join(" ")).not.toContain(knownHosts);
  });

  it("does not expose credential contents in save errors", async () => {
    const privateKey = "PRIVATE_KEY_ERROR_SENTINEL";
    const ui = harness([], async () => ({ ok: false, json: async () => ({ error: privateKey }) }));
    ui.run(`$("#global-git-name").value = "nas"; globalGitType.value = "ssh"; $("#global-ssh-key").value = ${JSON.stringify(privateKey)}; $("#global-known-hosts").value = "trusted host key";`);
    await ui.elements.get("#global-git-credential-form")!.listeners.get("submit")!({ preventDefault() {} });
    expect(ui.elements.get("#git-credential-error")?.textContent).toContain("Could not save Git credential");
    expect(ui.elements.get("#git-credential-error")?.textContent).not.toContain(privateKey);
    expect(ui.elements.get("#global-ssh-key")?.value).toBe("");
    expect(ui.stored.join(" ")).not.toContain(privateKey);
  });

  it("passes only the selected credential ID with generic NAS remotes and omits it without a repository", async () => {
    const ui = harness([], async () => ({ ok: true, json: async () => ({ sessionId: "session-1" }) }));
    for (const repository of ["nas:/repo.git", "ssh://user@nas/repo.git"]) {
      ui.run(`newTarget.value = "local"; newRepository.value = ${JSON.stringify(repository)}; savedProject.value = ""; newGitCredential.value = "credential-id"; syncWorkspaceCreateFields()`);
      const workspaceOptions = await ui.run("newWorkspaceOptions()");
      await ui.run(`createSession("local", undefined, ${JSON.stringify(workspaceOptions)})`);
      const request = ui.requests.at(-1)!;
      expect(request.url).toContain("/api/sessions");
      expect(JSON.parse(String(request.options?.body))).toMatchObject({ repository, credentialIds: ["credential-id"] });
      expect(String(request.options?.body)).not.toContain("PRIVATE_KEY");
    }
    ui.run('newRepository.value = ""; newGitCredential.value = "credential-id"; syncWorkspaceCreateFields()');
    expect(await ui.run("newWorkspaceOptions()")).toEqual({});
    expect(ui.elements.get("#new-git-credential")?.disabled).toBe(true);
  });
});
