import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDoctor, renderDoctor } from "../src/doctor.js";

describe("porta doctor", () => {
  it("reports a healthy supported runtime and safe defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-doctor-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    await writeFile(join(root, "web-index-placeholder"), "");
    const report = await collectDoctor({ cwd: root, packageRoot: process.cwd(), nodeVersion: "22.19.0", executable: join(root, "porta") });
    expect(report.ok).toBe(true);
    expect(report.runtime.supported).toBe(true);
    expect(report.workspace.mutation).toBe(false);
    expect(report.workspace.execution).toBe(false);
    expect(renderDoctor(report)).toContain("Overall: OK");
  });

  it("fails when the runtime is below the supported minimum", async () => {
    const report = await collectDoctor({ cwd: await mkdtemp(join(tmpdir(), "porta-doctor-")), packageRoot: process.cwd(), nodeVersion: "22.18.9" });
    expect(report.ok).toBe(false);
    expect(report.runtime.supported).toBe(false);
    expect(report.checks.find((check) => check.id === "node-version")?.status).toBe("failed");
  });

  it("keeps JSON diagnostics structured and secret-free", async () => {
    const report = await collectDoctor({ cwd: await mkdtemp(join(tmpdir(), "porta-doctor-")), packageRoot: process.cwd(), nodeVersion: "22.19.0" });
    const json = JSON.stringify(report);
    expect(JSON.parse(json)).toHaveProperty("runtime.nodeExecutable");
    expect(json).not.toMatch(/"(?:access|refresh|apiKey|authorization)"\s*:/i);
  });
});
