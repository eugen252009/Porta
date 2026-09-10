import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "integrations", "chatgpt-browser-extension");
const content = readFileSync(join(root, "content.js"), "utf8"); const client = readFileSync(join(root, "porta-client.js"), "utf8"); const background = readFileSync(join(root, "background.js"), "utf8"); const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

describe("ChatGPT Porta extension", () => {
  it("uses explicit user action and idempotent artifact controls", () => { expect(content).toContain("Send to Porta ▾"); expect(content).toContain("MutationObserver"); expect(content).toContain("data-porta-control"); expect(content).toContain("crypto.randomUUID()"); expect(content).toContain("data-testid=code-block"); expect(content).not.toContain("setInterval"); });
  it("extracts assistant artifacts without privileged Porta operations", () => { expect(content).toContain("data-message-author-role=\"assistant\""); expect(content).toContain("extractArtifactMarkdown"); expect(content).toContain("artifact.matches(\"pre\")"); expect(content).not.toContain("querySelector(\".markdown, .prose\")"); expect(client).toContain("chrome.runtime.sendMessage"); expect(content).not.toMatch(/ssh|docker|filesystem|execution\.run/i); });
  it("uses a scoped extension origin and no embedded credential", () => { expect(manifest.manifest_version).toBe(3); expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining(["https://*/*"])); expect(manifest.background.service_worker).toBe("background.js"); expect(background).toContain("Authorization"); expect(client).not.toContain("Authorization"); expect(client).not.toContain("chrome.storage"); expect(background).toContain("UNKNOWN_EXTENSION_ACTION"); expect(background).toContain("sessionMappings"); expect(background).toContain("sessionId"); expect(background).not.toContain("message.url"); });
});
