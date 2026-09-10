import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "integrations", "chatgpt-browser-extension");
const content = readFileSync(join(root, "content.js"), "utf8"); const client = readFileSync(join(root, "porta-client.js"), "utf8"); const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

describe("ChatGPT Porta extension", () => {
  it("uses explicit user action and idempotent artifact controls", () => { expect(content).toContain("Send to Porta ▾"); expect(content).toContain("MutationObserver"); expect(content).toContain("data-porta-control"); expect(content).toContain("crypto.randomUUID()"); expect(content).not.toContain("setInterval"); });
  it("extracts assistant artifacts without privileged Porta operations", () => { expect(content).toContain("data-message-author-role=\"assistant\""); expect(content).toContain("renderedToMarkdown"); expect(client).toContain("/api/nodes"); expect(client).toContain("/api/prompt/submit"); expect(content).not.toMatch(/ssh|docker|filesystem|execution\.run/i); });
  it("uses a scoped extension origin and no embedded credential", () => { expect(manifest.manifest_version).toBe(3); expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining(["https://*/*"])); expect(client).toContain("Authorization"); expect(client).not.toContain("porta_int_"); });
});
